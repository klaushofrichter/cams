import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// The Pi's compose file (security review 2026-10-04): cams gets only its own
// variables from the Pi's one settings file, never cam-proxy's secrets.
const text = readFileSync(join(__dirname, '..', 'deploy', 'pi', 'compose.cams.yaml'), 'utf8');
const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('deploy/pi/compose.cams.yaml', () => {
  it('has no env_file', () => {
    expect(code).not.toMatch(/env_file/);
  });
  it('substitutes only cams variables', () => {
    const vars = [...new Set([...code.matchAll(/\$\{([A-Z_]+)/g)].map((m) => m[1]))].sort();
    expect(vars).toEqual(['CAMS_LOGIN_TOKEN', 'CAMS_TAG', 'CAMS_TOKEN_USER', 'COOKIE_SECRET']);
  });
  it('requires the token and the cookie secret', () => {
    expect(code).toMatch(/CAMS_LOGIN_TOKEN: \$\{CAMS_LOGIN_TOKEN:\?/);
    expect(code).toMatch(/COOKIE_SECRET: \$\{COOKIE_SECRET:\?/);
  });
});
