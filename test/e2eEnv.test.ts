import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { CAM_PROXY_DIGEST, CAM_PROXY_IMAGE, CAM_PROXY_TAG, realProxyOn } from '../e2e/env';

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
  it('is off with CAMS_E2E_REAL_PROXY=0, even on GitHub Actions (the time-of-day runs)', () => {
    expect(realProxyOn({ GITHUB_ACTIONS: 'true', CAMS_E2E_REAL_PROXY: '0' }, 'linux')).toBe(false);
  });
  it('is off by default', () => {
    expect(realProxyOn({}, 'linux')).toBe(false);
    expect(realProxyOn({ CAMS_E2E_REAL_PROXY: 'true' }, 'linux')).toBe(false);
  });
});

// Issue #132: the e2e's cam-proxy image is pinned by digest as well as tag.
describe('the pinned cam-proxy image', () => {
  it('is the tag pinned by a sha256 digest', () => {
    expect(CAM_PROXY_TAG).toMatch(/^v\d{4}\.\d{2}\.\d{2}\.\d+$/);
    expect(CAM_PROXY_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(CAM_PROXY_IMAGE).toBe(`ghcr.io/klaushofrichter/cam-proxy:${CAM_PROXY_TAG}@${CAM_PROXY_DIGEST}`);
  });

  it('is what production-checks.yml pulls: its sed lines read the same tag and digest from e2e/env.ts', () => {
    const step = readFileSync('.github/workflows/production-checks.yml', 'utf8').split('\n').filter((l) => /^\s+(TAG|DIGEST)=\$\(sed /.test(l));
    expect(step).toHaveLength(2);
    const out = execFileSync('bash', ['-c', `${step.map((l) => l.trim()).join('\n')}\necho "$TAG@$DIGEST"`], { encoding: 'utf8' }).trim();
    expect(`ghcr.io/klaushofrichter/cam-proxy:${out}`).toBe(CAM_PROXY_IMAGE);
  });
});
