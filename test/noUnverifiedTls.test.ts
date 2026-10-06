// Chain validation is skipped in one file only (server/tls/leafPin.ts, the
// one CodeQL exception): anywhere else in server/, rejectUnauthorized may only
// be `true`. Lines are filtered, never rewritten.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', 'server');
const ALLOWED = 'tls/leafPin.ts';
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('TLS without chain validation', () => {
  it('exists only in server/tls/leafPin.ts', () => {
    const found: string[] = [];
    for (const file of tsFiles(ROOT)) {
      const rel = relative(ROOT, file);
      if (rel === ALLOWED) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.includes('rejectUnauthorized') && !line.trim().startsWith('//') && !line.includes('rejectUnauthorized: true'))
        .forEach((line) => found.push(`${rel}: ${line.trim()}`));
    }
    expect(found).toEqual([]);
  });

  it('still finds the allowed file (the scan looks where it should)', () => {
    expect(tsFiles(ROOT).map((f) => relative(ROOT, f))).toContain(ALLOWED);
  });
});
