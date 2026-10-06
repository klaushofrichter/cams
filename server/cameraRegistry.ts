import { EventEmitter } from 'events';
import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { logger } from './logger';
import { proxyEnabled } from './proxyState';
import { proxyGroupKey } from './proxy/groupKey';
import { fingerprintList } from './tls/fingerprint';
import { pinTransportOk } from './tls/loopback';

export interface CameraConfig {
  id: string;
  name: string;
  // IP or hostname, optionally with :port; or "from-proxy" (with a proxy):
  // the address its cam-proxy reports (spec 2026-10-04-camera-address-from-proxy-design).
  host: string;
  protocol: 'https' | 'http';
  // When set, the camera's TLS certificate is verified against this name
  // (the camera is reached by IP, but its certificate is for a hostname).
  tlsServername?: string;
  user: string;
  password: string;
  // The camera's own web page. Unset: https://<host>/. null: no link.
  webUiUrl?: string | null;
  // Shown instead of a link, e.g. for a simulated camera without a web UI.
  webUiNote?: string;
  // The camera's cam-proxy (events, stills, clips). The token is a cam-proxy
  // client token: it stays on the server.
  // `camera`: the proxy's id for this camera, when it isn't the same as ours.
  // adminToken: optional, the proxy's admin token, used only to mint one-time
  // sign-in links into its UI for a signed-in user (Klaus, 2026-09-28).
  // caFingerprint / tlsServername: the proxy's site CA pin(s) and TLS name
  // (cam-proxy spec 2026-10-05 §12.1), equal across a group: with a pin,
  // cams trusts only that CA for the proxy and its cameras (server/tls/).
  proxy?: ProxyConfig;
}

export interface ProxyConfig { url: string; token: string; adminToken?: string; camera?: string; caFingerprint?: string[]; tlsServername?: string }

export interface CameraSummary {
  id: string;
  name: string;
  webUiUrl: string | null;
  webUiNote?: string;
  proxy: boolean; // whether cams uses this camera's cam-proxy now (never its URL or token)
  proxyConfigured: boolean; // whether the camera has a cam-proxy at all (the switch on Settings)
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FIELDS = ['id', 'name', 'host', 'user', 'password'] as const;

let cameras: CameraConfig[] = [];

// The registry comes from the cams-cameras Secret, mounted as a file. A
// configured path that doesn't exist yet (Secret not created) means "no
// cameras" so the app still starts; anything present but wrong fails startup
// with a message naming the problem, never a half-loaded list.
export function loadCameras(file: string | undefined = process.env.CAMERAS_FILE): CameraConfig[] {
  if (!file) return [];
  if (!existsSync(file)) {
    logger.warn({ file: basename(file) }, 'camera registry file not found; no cameras configured');
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`camera registry ${basename(file)} is not valid JSON`);
  }
  const list = parseCameras(parsed, basename(file));
  // https without a name to check and without a pinned proxy: unverified, as
  // before P5 (server/tls/leafPin.ts LEGACY_UNVERIFIED_CAMERA). Said once, at start.
  for (const c of list) if (c.protocol === 'https' && !c.tlsServername && !c.proxy?.caFingerprint) logger.warn({ cameraId: c.id }, 'camera_tls_unverified');
  return list;
}

// The registry's checks on a parsed file (also the generator's, before it
// writes one). `label` names the file in errors.
export function parseCameras(parsed: unknown, label: string): CameraConfig[] {
  if (!Array.isArray(parsed)) throw new Error(`camera registry ${label} must be a JSON array`);

  const seen = new Set<string>();
  const list = parsed.map((entry: unknown, i: number) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`camera registry entry ${i} is not an object`);
    const e = entry as Record<string, unknown>;
    for (const field of FIELDS) {
      if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
        throw new Error(`camera registry entry ${i}: field "${field}" must be a non-empty string`);
      }
    }
    if (!ID_PATTERN.test(e.id as string)) {
      throw new Error(`camera registry entry ${i}: id must match ${ID_PATTERN}`);
    }
    if (seen.has(e.id as string)) throw new Error(`camera registry: duplicate id "${e.id}"`);
    if (e.host === FROM_PROXY && e.proxy === undefined) throw new Error(`camera registry entry ${i}: host "${FROM_PROXY}" needs a proxy`);
    seen.add(e.id as string);
    if (e.protocol !== undefined && e.protocol !== 'https' && e.protocol !== 'http') {
      throw new Error(`camera registry entry ${i}: protocol must be "https" or "http"`);
    }
    if (e.tlsServername !== undefined && (typeof e.tlsServername !== 'string' || e.tlsServername.length === 0)) {
      throw new Error(`camera registry entry ${i}: tlsServername must be a non-empty string`);
    }
    if (e.webUiUrl !== undefined && e.webUiUrl !== null && !(typeof e.webUiUrl === 'string' && /^https?:\/\/[^\s]+$/.test(e.webUiUrl))) {
      throw new Error(`camera registry entry ${i}: webUiUrl must be an http(s) URL or null`);
    }
    if (e.webUiNote !== undefined && !(typeof e.webUiNote === 'string' && e.webUiNote.length > 0 && e.webUiNote.length <= 120)) {
      throw new Error(`camera registry entry ${i}: webUiNote must be a string of 1 to 120 characters`);
    }
    // An address from the proxy is only trusted behind a certificate check:
    // a compromised proxy must not point the camera login at another host
    // (security review 2026-10-04). With a pinned site CA that check is the
    // CA (or the leaf pin the proxy reports over the pinned channel), so a
    // camera on the leaf-pin fallback needs no name (spec 2026-10-05 §12.1).
    const pinned = typeof e.proxy === 'object' && e.proxy !== null && (e.proxy as Record<string, unknown>).caFingerprint !== undefined;
    if (e.host === FROM_PROXY && ((e.protocol ?? 'https') !== 'https' || (e.tlsServername === undefined && !pinned))) {
      throw new Error(`camera registry entry ${i}: host "${FROM_PROXY}" needs protocol "https" and a tlsServername (or a proxy caFingerprint)`);
    }
    const proxy = e.proxy === undefined ? undefined : proxyOf(e.proxy, i);
    const camera: CameraConfig = {
      id: e.id as string,
      name: e.name as string,
      host: e.host as string,
      protocol: (e.protocol as 'https' | 'http' | undefined) ?? 'https',
      user: e.user as string,
      password: e.password as string,
    };
    if (e.tlsServername !== undefined) camera.tlsServername = e.tlsServername as string;
    if (e.webUiUrl !== undefined) camera.webUiUrl = e.webUiUrl as string | null;
    if (e.webUiNote !== undefined) camera.webUiNote = e.webUiNote as string;
    if (proxy) camera.proxy = proxy;
    return camera;
  });
  checkProxyGroups(list);
  return list;
}

// Entries with the same proxy url + token are one cam-proxy (spec
// 2026-10-05 §12.1): their pins and TLS names are equal, and their admin
// tokens can't disagree (an entry without one keeps no sign-in link, as
// before).
function checkProxyGroups(list: CameraConfig[]): void {
  const first = new Map<string, { i: number; c: CameraConfig }>();
  list.forEach((c, i) => {
    if (!c.proxy) return;
    const key = proxyGroupKey(c.proxy);
    const f = first.get(key);
    if (!f) return void first.set(key, { i, c });
    for (const field of ['caFingerprint', 'tlsServername'] as const) {
      if (JSON.stringify(f.c.proxy![field]) !== JSON.stringify(c.proxy[field])) {
        throw new Error(`camera registry entries ${f.i} ("${f.c.id}") and ${i} ("${c.id}"): same cam-proxy (url and token) but different ${field}`);
      }
    }
  });
  const admin = new Map<string, { i: number; id: string; token: string }>();
  list.forEach((c, i) => {
    if (!c.proxy?.adminToken) return;
    const key = proxyGroupKey(c.proxy);
    const first = admin.get(key);
    if (!first) return void admin.set(key, { i, id: c.id, token: c.proxy.adminToken });
    if (first.token !== c.proxy.adminToken) {
      throw new Error(`camera registry entries ${first.i} ("${first.id}") and ${i} ("${c.id}"): same cam-proxy (url and token) but different adminToken`);
    }
  });
}

// {url, token}: an http(s) URL without credentials, query or hash, and a
// token of 32+ characters without whitespace. Errors never quote the token.
function proxyOf(v: unknown, i: number): ProxyConfig {
  const fail = (what: string): never => {
    throw new Error(`camera registry entry ${i}: proxy ${what}`);
  };
  if (typeof v !== 'object' || v === null) fail('must be an object {url, token}');
  const p = v as Record<string, unknown>;
  let url: URL | undefined;
  try {
    url = new URL(String(p.url));
  } catch {
    fail('url must be an http(s) URL');
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) fail('url must be an http(s) URL');
  if (url!.username || url!.password || url!.search || url!.hash) fail('url must have no credentials, query or hash');
  const secret = (v: unknown, name: string) => {
    if (typeof v !== 'string' || v.length < 32 || /\s/.test(v)) fail(`${name} must be a string of 32 or more characters without spaces`);
  };
  secret(p.token, 'token');
  if (p.adminToken !== undefined) secret(p.adminToken, 'adminToken');
  if (p.camera !== undefined && !(typeof p.camera === 'string' && ID_PATTERN.test(p.camera))) fail(`camera must match ${ID_PATTERN}`);
  const pins = p.caFingerprint === undefined ? undefined : fingerprintList(p.caFingerprint);
  if (pins === null) fail('caFingerprint must be a SHA-256 fingerprint or a list of them');
  if (pins && !pinTransportOk(url!)) fail('caFingerprint needs an https url (or a loopback http one)');
  if (p.tlsServername !== undefined) {
    if (typeof p.tlsServername !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(p.tlsServername)) fail('tlsServername must be a host name');
    if (url!.protocol !== 'https:') fail('tlsServername needs an https url');
  }
  return {
    url: String(p.url).replace(/\/+$/, ''),
    token: p.token as string,
    ...(p.adminToken !== undefined && { adminToken: p.adminToken as string }),
    ...(p.camera !== undefined && { camera: p.camera as string }),
    ...(pins && { caFingerprint: pins }),
    ...(p.tlsServername !== undefined && { tlsServername: p.tlsServername as string }),
  };
}

export function setCameras(list: CameraConfig[]): void {
  cameras = list;
  reported.clear();
  reportedAddress.clear();
}

// A camera whose address comes from its cam-proxy (spec
// 2026-10-04-camera-address-from-proxy-design): `"host": "from-proxy"`.
export const FROM_PROXY = 'from-proxy';
const reportedAddress = new Map<string, string>();
// 'address' {cam, address}: a from-proxy camera's address changed (the
// direct client is built again for it).
export const addressEvents = new EventEmitter();
addressEvents.setMaxListeners(0);

// An address or name with an optional :port (1-65535), as cam-proxy's
// camera.host from CAMERA_HOST.
export function validCameraAddress(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = /^([A-Za-z0-9][A-Za-z0-9.-]{0,252})(?::([0-9]{1,5}))?$/.exec(v);
  return !!m && (m[2] === undefined || (Number(m[2]) >= 1 && Number(m[2]) <= 65535));
}

export const hostFromProxy = (cam: CameraConfig | undefined): boolean => cam?.host === FROM_PROXY;

// Where cams reaches the camera directly: the configured host, or for a
// from-proxy camera the address its proxy last reported (undefined until
// then). It stays while the proxy is away: the direct features need it most then.
export function cameraHost(id: string): string | undefined {
  const cam = getCamera(id);
  if (!cam) return undefined;
  return hostFromProxy(cam) ? reportedAddress.get(id) : cam.host;
}

// What the proxy reported; anything but an address is ignored. Announced
// only on a change, and only for a from-proxy camera.
export function setReportedAddress(id: string, address: unknown): void {
  if (!hostFromProxy(getCamera(id))) return;
  if (!validCameraAddress(address)) {
    if (address !== undefined) logger.debug({ cameraId: id }, 'proxy_address_ignored');
    return;
  }
  if (reportedAddress.get(id) === address) return;
  reportedAddress.set(id, address);
  logger.info({ cameraId: id, address }, 'camera_address_from_proxy');
  addressEvents.emit('address', { cam: id, address });
}

// The camera's own name (design camera-name-design.md): the camera stores
// it; cams shows what the camera (through its cam-proxy, or read directly)
// last reported, and the registry name until then. The id never changes.
const reported = new Map<string, string>();
// 'name' {cam, name}: a camera's shown name changed (the browser relay).
export const nameEvents = new EventEmitter();
nameEvents.setMaxListeners(0);

export function cameraName(id: string): string {
  return reported.get(id) ?? getCamera(id)?.name ?? id;
}

// What the camera reported (null: nothing now, e.g. its proxy is
// unreachable, so the registry name again). Announced only on a change.
export function setReportedName(id: string, name: string | null): void {
  if (!getCamera(id)) return;
  const before = cameraName(id);
  if (name === null) reported.delete(id);
  else reported.set(id, name);
  const now = cameraName(id);
  if (now !== before) nameEvents.emit('name', { cam: id, name: now });
}

export function listCameras(): CameraSummary[] {
  return cameras.map((c) => ({ id: c.id, name: cameraName(c.id), ...webUiOf(c), proxy: proxyActive(c.id), proxyConfigured: !!c.proxy }));
}

// Ids of the cameras whose cam-proxy is in use.
// Every configured camera, config order (the same array until setCameras).
export function allCameras(): readonly CameraConfig[] {
  return cameras;
}

export function listProxied(): string[] {
  return cameras.filter((c) => proxyActive(c.id)).map((c) => c.id);
}

// A camera with a cam-proxy that isn't switched off on the Settings page.
export function proxyActive(id: string): boolean {
  return !!getCamera(id)?.proxy && proxyEnabled(id);
}

export function getCamera(id: string): CameraConfig | undefined {
  return cameras.find((c) => c.id === id);
}

// The link to the camera's web page, or a note instead of one. A configured
// webUiUrl wins; a note alone means no link; otherwise the LAN address.
export function webUiOf(cam: CameraConfig): { webUiUrl: string | null; webUiNote?: string } {
  const webUiUrl = cam.webUiUrl !== undefined ? cam.webUiUrl : cam.webUiNote ? null : webUiUrlOf(cam);
  return cam.webUiNote ? { webUiUrl, webUiNote: cam.webUiNote } : { webUiUrl };
}

// The camera's own web UI, by LAN address: it's reachable from the home
// network only (docs/reolink-api.md, "Camera authentication").
// A from-proxy camera has none until its address is known.
function webUiUrlOf(cam: CameraConfig): string | null {
  const h = cameraHost(cam.id) ?? (hostFromProxy(cam) ? undefined : cam.host);
  if (!h) return null;
  const host = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  return `https://${host}/`;
}
