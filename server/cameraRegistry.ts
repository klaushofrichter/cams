import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { logger } from './logger';
import { proxyEnabled } from './proxyState';

export interface CameraConfig {
  id: string;
  name: string;
  host: string; // IP or hostname, optionally with :port
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
  proxy?: { url: string; token: string; adminToken?: string; camera?: string };
}

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
  if (!Array.isArray(parsed)) throw new Error(`camera registry ${basename(file)} must be a JSON array`);

  const seen = new Set<string>();
  return parsed.map((entry: unknown, i: number) => {
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
}

// {url, token}: an http(s) URL without credentials, query or hash, and a
// token of 32+ characters without whitespace. Errors never quote the token.
function proxyOf(v: unknown, i: number): { url: string; token: string; adminToken?: string; camera?: string } {
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
  return {
    url: String(p.url).replace(/\/+$/, ''),
    token: p.token as string,
    ...(p.adminToken !== undefined && { adminToken: p.adminToken as string }),
    ...(p.camera !== undefined && { camera: p.camera as string }),
  };
}

export function setCameras(list: CameraConfig[]): void {
  cameras = list;
}

export function listCameras(): CameraSummary[] {
  return cameras.map((c) => ({ id: c.id, name: c.name, ...webUiOf(c), proxy: proxyActive(c.id), proxyConfigured: !!c.proxy }));
}

// Ids of the cameras whose cam-proxy is in use.
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
function webUiUrlOf(cam: CameraConfig): string {
  const host = cam.host.startsWith('[') ? cam.host.slice(0, cam.host.indexOf(']') + 1) : cam.host.split(':')[0];
  return `https://${host}/`;
}
