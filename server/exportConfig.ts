// export-config (migration P4, M §11.1): a redacted export of cameras.json
// for cams-admin's import — every camera field but the password, tokens
// only as {sha256: <hex>}, and the local stores' counts. The shape is
// cams-admin's CamsExport (server/import/export-format.ts there).
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { loadCameras } from './cameraRegistry';
import { proxyStateFile } from './proxyState';
import { tlsStateFile } from './tls/store';

export interface ExportProxy { url: string; token: { sha256: string }; adminToken?: { sha256: string }; camera?: string; caFingerprint?: string[]; tlsServername?: string }
export interface ExportCamera { id: string; name: string; host: string; protocol: 'https' | 'http'; tlsServername?: string; webUiUrl?: string | null; webUiNote?: string; user: string; proxy?: ExportProxy }
export interface CamsExport {
  v: 1; kind: 'cams-export'; exportedAt: number; camsVersion: string; source: 'cameras-file';
  cameras: ExportCamera[];
  counts: { preferencesUsers: number; proxySwitchOff: number; tlsCas: number; tlsPins: number };
}

const sha = (t: string) => ({ sha256: createHash('sha256').update(t).digest('hex') });
const readJson = (f: string | undefined): unknown => {
  if (!f) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as unknown;
  } catch {
    return null;
  }
};
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// Either layout (server/stateLayout.ts): the old one's data, or every account's.
const entries = (v: unknown): Record<string, unknown>[] => {
  if (!obj(v)) return [];
  if (v.v === 2 && obj(v.accounts)) return Object.values(v.accounts).map((e) => (obj(e) && obj(e.data) ? e.data : {}));
  return [v];
};

export function exportConfig(now: () => number = Date.now, camsVersion = 'dev'): CamsExport {
  const cameras = loadCameras().map((c): ExportCamera => ({
    id: c.id, name: c.name, host: c.host, protocol: c.protocol,
    ...(c.tlsServername !== undefined && { tlsServername: c.tlsServername }),
    user: c.user,
    ...(c.webUiUrl !== undefined && { webUiUrl: c.webUiUrl }),
    ...(c.webUiNote !== undefined && { webUiNote: c.webUiNote }),
    ...(c.proxy && {
      proxy: {
        url: c.proxy.url, token: sha(c.proxy.token),
        ...(c.proxy.adminToken && { adminToken: sha(c.proxy.adminToken) }),
        ...(c.proxy.camera && { camera: c.proxy.camera }),
        ...(c.proxy.caFingerprint && { caFingerprint: c.proxy.caFingerprint }),
        ...(c.proxy.tlsServername && { tlsServername: c.proxy.tlsServername }),
      },
    }),
  }));
  const tls = readJson(tlsStateFile());
  return {
    v: 1, kind: 'cams-export', exportedAt: now(), camsVersion: camsVersion.slice(0, 64) || 'dev', source: 'cameras-file', cameras,
    counts: {
      preferencesUsers: entries(readJson(process.env.PREFS_FILE)).reduce((n, e) => n + Object.keys(e).length, 0),
      proxySwitchOff: entries(readJson(proxyStateFile())).reduce((n, e) => n + Object.values(e).filter((x) => x === false).length, 0),
      tlsCas: obj(tls) && obj(tls.cas) ? Object.keys(tls.cas).length : 0,
      tlsPins: obj(tls) && obj(tls.pins) ? Object.keys(tls.pins).length : 0,
    },
  };
}
