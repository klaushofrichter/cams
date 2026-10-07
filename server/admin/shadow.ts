// The shadow comparison (migration P4, M §9.4, §11.3): cameras.json against
// cams-admin's snapshot for the file account, field by field. Items name a
// camsId and a field, never a value; tokens and passwords are never compared.
import type { FileCameraConfig } from '../cameraRegistry';
import { normalizeFingerprint } from '../tls/fingerprint';
import type { AccountPart } from './snapshot';

interface Side { name: string; host: string; protocol: string; tlsServername: string | null; webUiUrl: string | null; webUiNote: string | null; user: string | null; proxy: { url: string; camera: string; caFingerprint: string[]; tlsServername: string | null } | null }

const url = (u: string) => u.replace(/\/+$/, '');
const pins = (l: string[] | undefined) => (l ?? []).map((f) => normalizeFingerprint(f) ?? f).sort();

function fileSide(c: FileCameraConfig): Side {
  return {
    name: c.name, host: c.host, protocol: c.protocol, tlsServername: c.tlsServername ?? null, webUiUrl: c.webUiUrl ?? null, webUiNote: c.webUiNote ?? null, user: c.user,
    proxy: c.proxy ? { url: url(c.proxy.url), camera: c.proxy.camera ?? c.id, caFingerprint: pins(c.proxy.caFingerprint), tlsServername: c.proxy.tlsServername ?? null } : null,
  };
}

function snapSide(part: AccountPart, camsId: string): Side | null {
  const c = part.cameras.find((x) => x.camsId === camsId);
  if (!c) return null;
  const p = c.proxyId ? part.proxies.find((x) => x.id === c.proxyId) : undefined;
  return {
    name: c.name, host: c.host, protocol: c.protocol, tlsServername: c.tlsServername, webUiUrl: c.webUiUrl, webUiNote: c.webUiNote, user: c.cameraUser,
    proxy: p && p.url ? { url: url(p.url), camera: c.proxyCameraId ?? c.camsId, caFingerprint: pins(p.caFingerprints), tlsServername: p.tlsServername } : null,
  };
}

const FIELDS = ['name', 'host', 'protocol', 'tlsServername', 'webUiUrl', 'webUiNote', 'user'] as const;
const PROXY_FIELDS = ['url', 'camera', 'caFingerprint', 'tlsServername'] as const;

export function shadowDiff(file: FileCameraConfig[], part: AccountPart | undefined): string[] {
  const items: string[] = [];
  const snapIds = new Set(part?.cameras.map((c) => c.camsId) ?? []);
  for (const c of file) {
    const s = part ? snapSide(part, c.id) : null;
    if (!s) {
      items.push(`${c.id}: only in the file`);
      continue;
    }
    const f = fileSide(c);
    for (const k of FIELDS) if (f[k] !== s[k]) items.push(`${c.id}: ${k}`);
    if (!f.proxy !== !s.proxy) items.push(`${c.id}: proxy`);
    else if (f.proxy && s.proxy) for (const k of PROXY_FIELDS) if (JSON.stringify(f.proxy[k]) !== JSON.stringify(s.proxy[k])) items.push(`${c.id}: proxy.${k}`);
  }
  const fileIds = new Set(file.map((c) => c.id));
  for (const id of snapIds) if (!fileIds.has(id)) items.push(`${id}: only in cams-admin`);
  return items;
}
