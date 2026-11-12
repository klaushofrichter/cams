// scripts/lighthouse-gate.sh with a fake Lighthouse (LH_CMD): which runs
// count, and the floors. The first run on a cold GitHub runner scored 77–86
// where the next ones scored 94+ (2026-11-12): a warm-up run is not scored.
import { describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { mkdtempSync, writeFileSync, chmodSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const GATE = resolve(__dirname, '..', 'scripts', 'lighthouse-gate.sh');

// A fake `lighthouse URL ... --output-path=P`: its Nth call scores perf[N-1]
// (the last one after that), 1 elsewhere, and writes P.report.json/html.
function fakeLighthouse(dir: string, perf: number[]): string {
  const bin = join(dir, 'fake-lighthouse');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const n = Number(fs.existsSync(${JSON.stringify(join(dir, 'count'))}) ? fs.readFileSync(${JSON.stringify(join(dir, 'count'))}, 'utf8') : 0) + 1;
fs.writeFileSync(${JSON.stringify(join(dir, 'count'))}, String(n));
const perf = ${JSON.stringify(perf)};
const out = process.argv.find((a) => a.startsWith('--output-path=')).slice('--output-path='.length);
const audit = (v) => ({ score: 1, scoreDisplayMode: 'numeric', displayValue: v });
const report = {
  categories: { performance: { score: perf[Math.min(n, perf.length) - 1] }, accessibility: { score: 1 }, 'best-practices': { score: 1 }, seo: { score: 1 } },
  audits: { 'first-contentful-paint': audit('1 s'), 'largest-contentful-paint': audit('1 s'), 'cumulative-layout-shift': audit('0'), 'total-blocking-time': audit('0 ms'), 'total-byte-weight': audit('1 KiB') },
};
fs.writeFileSync(out + '.report.json', JSON.stringify(report));
fs.writeFileSync(out + '.report.html', '<html></html>');
`);
  chmodSync(bin, 0o755);
  return bin;
}

function gate(perf: number[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cams-lhgate-'));
  const bin = fakeLighthouse(dir, perf);
  return new Promise<{ code: number; out: string; dir: string }>((done) => {
    execFile('bash', [GATE, 'http://127.0.0.1:1/'], { cwd: dir, env: { ...process.env, CHROME_PATH: '/bin/true', LH_CMD: bin, ...env } }, (err, stdout, stderr) =>
      done({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout + stderr, dir }),
    );
  });
}

describe('scripts/lighthouse-gate.sh', { timeout: 30_000 }, () => {
  it('a slow first run is the warm-up and does not count', async () => {
    const r = await gate([0.5, 0.5, 0.95]);
    expect(r.out).toContain('Lighthouse performance per run: 50 95 95');
    expect(r.out).toContain('Lighthouse performance: 95 (floor 90)');
    expect(r.code).toBe(0);
    // Only the median run's report is left.
    expect(readdirSync(r.dir).filter((f) => f.includes('report')).sort()).toEqual(['lighthouse-report.report.html', 'lighthouse-report.report.json']);
  });

  it('without the warm-up (LH_WARMUP=0) the same runs fail', async () => {
    const r = await gate([0.5, 0.5, 0.95], { LH_WARMUP: '0' });
    expect(r.out).toContain('Lighthouse performance per run: 50 50 95');
    expect(r.out).toContain('::error::Lighthouse performance is 50, below 90');
    expect(r.code).toBe(1);
  });

  it('slow measured runs still fail', async () => {
    const r = await gate([0.95, 0.8, 0.8, 0.95]);
    expect(r.out).toContain('::error::Lighthouse performance is 80, below 90');
    expect(r.code).toBe(1);
  });
});
