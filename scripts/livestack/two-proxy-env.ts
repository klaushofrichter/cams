// The two-proxy stack's run.env (start-two-proxy-stack.sh), read without
// evaluating it: KEY=value lines. Holds per-run tokens: never print it.
import { readFileSync } from 'fs';
import { join } from 'path';

export function runEnvPath(): string {
  if (process.env.TWOPROXY_RUN_ENV) return process.env.TWOPROXY_RUN_ENV;
  const work = process.env.LIVESTACK_DIR ?? join((process.env.TMPDIR ?? '/tmp').replace(/\/+$/, ''), 'cams-livestack');
  return join(work, 'run.env');
}

let cached: Record<string, string> | undefined;
export function runEnv(): Record<string, string> {
  if (cached) return cached;
  let text = '';
  try {
    text = readFileSync(runEnvPath(), 'utf8');
  } catch {
    throw new Error(`no ${runEnvPath()}: start scripts/livestack/start-two-proxy-stack.sh first`);
  }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  if (out.STACK !== 'two-proxy') throw new Error(`${runEnvPath()} is not a two-proxy stack's (STACK=${out.STACK ?? '?'})`);
  cached = out;
  return out;
}
