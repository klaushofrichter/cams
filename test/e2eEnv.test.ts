import { describe, expect, it } from 'vitest';
import { realProxyOn } from '../e2e/env';

// The real cam-proxy e2e (e2e/realProxy.ts) uses host networking, so it must
// never start by accident off an ephemeral GitHub runner.
describe('realProxyOn', () => {
  it('is on for GitHub Actions on Linux', () => {
    expect(realProxyOn({ GITHUB_ACTIONS: 'true', CI: 'true' }, 'linux')).toBe(true);
  });
  it('is on with the explicit opt-in on Linux', () => {
    expect(realProxyOn({ CAMS_E2E_REAL_PROXY: '1' }, 'linux')).toBe(true);
  });
  it('is off for a plain CI=true (a local CI reproduction, another CI system)', () => {
    expect(realProxyOn({ CI: 'true' }, 'linux')).toBe(false);
    expect(realProxyOn({ CI: '1' }, 'linux')).toBe(false);
  });
  it('is off on anything but Linux, even on GitHub Actions or with the opt-in', () => {
    expect(realProxyOn({ GITHUB_ACTIONS: 'true' }, 'darwin')).toBe(false);
    expect(realProxyOn({ CAMS_E2E_REAL_PROXY: '1' }, 'darwin')).toBe(false);
    expect(realProxyOn({ CAMS_E2E_REAL_PROXY: '1' }, 'win32')).toBe(false);
  });
  it('is off by default', () => {
    expect(realProxyOn({}, 'linux')).toBe(false);
    expect(realProxyOn({ CAMS_E2E_REAL_PROXY: 'true' }, 'linux')).toBe(false);
  });
});
