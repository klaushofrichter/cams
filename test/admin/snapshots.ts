// Contract-shaped cams-config snapshots for the tests (contract cams-v1):
// two accounts, Alpha and Beta, each with "cam1" on its own proxy.
import { ALPHA, BETA } from '../helpers/fleet';
import { signSnapshot } from './fakeAdmin';

export const INSTANCE = 'cms_00000000000000000001';
export const PRX_A = 'prx_AAAAAAAAAAAAAAAAAAAA';
export const PRX_B = 'prx_BBBBBBBBBBBBBBBBBBBB';

export interface SnapOptions {
  alphaUrl?: string | null;
  betaUrl?: string | null;
  alphaHost?: string;
  betaHost?: string;
  revision?: string;
  homeName?: string; // Alpha's name (e.g. "home" for the file account)
  alphaCameras?: Record<string, unknown>[];
  alphaProxyExtra?: Record<string, unknown>;
  tokens?: { a?: unknown[]; b?: unknown[] };
  users?: { a?: unknown[]; b?: unknown[] };
}

export const snapCamera = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'cam_AAAAAAAAAAAAAAAAAAAA', camsId: 'cam1', name: 'Cam', proxyId: null, proxyCameraId: null, host: '127.0.0.1:9', protocol: 'http',
  tlsServername: null, cameraUser: 'cams', webUiUrl: null, webUiNote: null, ...o,
});

export function twoAccountsSnapshot(o: SnapOptions = {}): Record<string, unknown> {
  const proxy = (id: string, name: string, url: string | null, tokens: unknown[], extra: Record<string, unknown> = {}) => ({
    id, name, displayName: name, url, adminUiUrl: null, tlsServername: null, caFingerprints: [], tokens, ...extra,
  });
  const accounts = [
    {
      id: ALPHA, name: o.homeName ?? 'alpha', displayName: 'Alpha', revision: 1,
      users: o.users?.a ?? [{ email: 'both@example.org', role: 'admin', disabled: false }, { email: 'alpha@example.org', role: 'admin', disabled: false }],
      proxies: [proxy(PRX_A, 'pa', o.alphaUrl === undefined ? 'http://127.0.0.1:1/alpha' : o.alphaUrl, o.tokens?.a ?? [], o.alphaProxyExtra)],
      cameras: o.alphaCameras ?? [snapCamera({ id: 'cam_AAAAAAAAAAAAAAAAAAA1', name: 'Alpha cam', proxyId: PRX_A, proxyCameraId: 'cam1', host: o.alphaHost ?? '127.0.0.1:9' })],
    },
    {
      id: BETA, name: 'beta', displayName: 'Beta', revision: 1,
      users: o.users?.b ?? [{ email: 'both@example.org', role: 'viewer', disabled: false }],
      proxies: [proxy(PRX_B, 'pb', o.betaUrl === undefined ? 'http://127.0.0.1:1/beta' : o.betaUrl, o.tokens?.b ?? [])],
      cameras: [snapCamera({ id: 'cam_BBBBBBBBBBBBBBBBBBB1', name: 'Beta cam', proxyId: PRX_B, proxyCameraId: 'cam1', host: o.betaHost ?? '127.0.0.1:9' })],
    },
  ].sort((x, y) => (x.name < y.name ? -1 : 1));
  return { v: 1, type: 'cams-config', instance: { id: INSTANCE, name: 'cluster', rotateBefore: null }, revision: o.revision ?? 'r:00000000000000a1', generatedAt: 1791273600000, accounts };
}

export const SIGNED = (s: Record<string, unknown>) => signSnapshot(s);
