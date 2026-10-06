// scripts/e2e-time-of-day.ts
// Runs the time-of-day dependent e2e specs at fixed Chicago times (issue
// #213, cam-sim PR #93): the Video page collapses the hours far from "now",
// cam-sim's demo clips sit at fixed times of today and yesterday, and the
// fake cam-proxy keeps the last minutes of stills, so a spec can pass at
// noon and fail in the evening. Each run starts the whole stack fresh with
// every Node process's clock moved to the target (e2e/clockShift.cjs) and
// the browser's with it (e2e/clock.ts).
//   npm run build && npx tsx scripts/e2e-time-of-day.ts [--at HH:MM] [spec ...] [-- playwright options]
// Needs the e2e ports free (it never reuses running servers). Exits non-zero
// if any run fails.
import { spawnSync } from 'child_process';
import { resolve } from 'path';
import { chicagoMs } from '../e2e/fakeProxyData';

// Chicago wall-clock times; TZ is the Node processes' own zone (the GitHub
// runner's is UTC). 20:30 and 23:50 are already tomorrow in UTC; Auckland is
// a day ahead of Chicago all day.
export const RUNS: { at: string; tz: string }[] = [
  { at: '00:30', tz: 'UTC' },
  { at: '06:00', tz: 'UTC' },
  { at: '12:10', tz: 'UTC' },
  { at: '18:30', tz: 'UTC' },
  { at: '20:30', tz: 'UTC' },
  { at: '23:50', tz: 'UTC' },
  { at: '20:30', tz: 'Pacific/Auckland' },
];
const DEFAULT_SPECS = ['e2e/video.spec.ts', 'e2e/video-stage2.spec.ts'];

const chicagoDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));

// From now to the next time `hm` (HH:MM) shows on a Chicago clock: always
// forward (0 to 24 h), so a session cookie the server dates can't be expired
// in the browser's real time.
export function shiftTo(hm: string, now = Date.now()): number {
  for (const day of [0, 1]) {
    const t = chicagoMs(chicagoDay(now + day * 86_400_000), `${hm}:00`);
    if (t >= now) return t - now;
  }
  throw new Error(`no ${hm} ahead`);
}

function main(argv: string[]): number {
  const dash = argv.indexOf('--');
  const extra = dash >= 0 ? argv.splice(dash).slice(1) : [];
  const i = argv.indexOf('--at');
  const only = i >= 0 ? argv.splice(i, 2)[1] : undefined;
  if (only !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(only)) throw new Error(`--at wants HH:MM, not ${only}`);
  const specs = argv.length ? argv : DEFAULT_SPECS;
  const listed = RUNS.filter((r) => r.at === only);
  const runs = only === undefined ? RUNS : listed.length ? listed : [{ at: only, tz: 'UTC' }];
  const results: string[] = [];
  for (const { at, tz } of runs) {
    const shift = shiftTo(at);
    console.log(`\n=== ${at} America/Chicago (Node TZ ${tz}, clock +${(shift / 3_600_000).toFixed(2)} h) ===`);
    const r = spawnSync('npx', ['playwright', 'test', ...specs, '--project=desktop', '--project=phone', '--retries=0', `--output=test-results/time-of-day/${at.replace(':', '')}-${tz.replace('/', '-')}`, ...extra], {
      stdio: 'inherit',
      env: {
        ...process.env,
        CI: '1', // fresh servers at the shifted time: never reuse running ones
        CAMS_E2E_REAL_PROXY: '0', // the real cam-proxy's container can't be shifted
        TZ: tz,
        E2E_CLOCK_SHIFT_MS: String(shift),
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${resolve(__dirname, '../e2e/clockShift.cjs')}`.trim(),
      },
    });
    results.push(`${at} (${tz}): ${r.status === 0 ? 'passed' : 'FAILED'}`);
  }
  console.log(`\n${results.join('\n')}`);
  return results.some((l) => l.endsWith('FAILED')) ? 1 : 0;
}

if (typeof require !== 'undefined' && require.main === module) process.exitCode = main(process.argv.slice(2));
