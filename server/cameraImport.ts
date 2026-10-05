// The cameras.json generator (cam-proxy spec 2026-10-05 §13.3): from a short
// list of cam-proxies, one cams camera per camera each proxy serves. A
// library, so a later "Add proxy" in cams can use it (§13.4);
// scripts/cameras-config.ts is its command line. It never prints a secret:
// errors name a field, diffs show •••.
import { readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import type { Dispatcher } from 'undici';
import { validCameraAddress } from './cameraRegistry';
import { fingerprintList } from './tls/fingerprint';
import { fetchPinnedCa, fetchWith, siteCaDispatcher, SiteCaError } from './tls/siteCa';

export type Secret = string | { env: string } | { file: string };

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportCamera { id?: string; name?: string; user?: string; password?: string; protocol?: 'https' | 'http'; tlsServername?: string; host?: string; webUiUrl?: string | null; webUiNote?: string }
export interface ImportProxy {
  url: string;
  tlsServername?: string;
  caFingerprint?: string[];
  token: string;
  adminToken?: string;
  cameraUser: string;
  cameraPassword: string;
  prefix: string;
  protocol?: 'https' | 'http';
  cameras: Record<string, ImportCamera>;
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const fail = (path: string, what: string): never => {
  throw new ImportError(`${path}: ${what}`);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, path: string, optional = false): string | undefined => {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || !v.length) fail(path, 'must be a non-empty string');
  return v as string;
};

function secret(v: unknown, path: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  let value: string | undefined;
  if (typeof v === 'string') value = v;
  else if (isObj(v) && typeof v.env === 'string' && Object.keys(v).length === 1) {
    value = env[v.env];
    if (value === undefined || value === '') fail(path, `environment variable ${v.env} is not set`);
  } else if (isObj(v) && typeof v.file === 'string' && Object.keys(v).length === 1) {
    try {
      value = readFileSync(isAbsolute(v.file) ? v.file : join(baseDir, v.file), 'utf8').replace(/\r?\n$/, '');
    } catch {
      fail(path, `file ${v.file} is not readable`);
    }
  } else fail(path, 'must be a string, {"env": "NAME"} or {"file": "path"}');
  if (!value) fail(path, 'is empty');
  return value!;
}

const token = (v: unknown, path: string, baseDir: string, env: NodeJS.ProcessEnv): string => {
  const t = secret(v, path, baseDir, env);
  if (t.length < 32 || /\s/.test(t)) fail(path, 'must be 32 or more characters without spaces');
  return t;
};

function proxyUrl(v: unknown, path: string): string {
  let u: URL | undefined;
  try {
    u = new URL(String(v));
  } catch {
    u = undefined;
  }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) fail(path, 'must be an http(s) URL without credentials, query or hash');
  return String(v).replace(/\/+$/, '');
}

const protocolOf = (v: unknown, path: string): 'https' | 'http' | undefined => {
  if (v === undefined) return undefined;
  if (v !== 'https' && v !== 'http') fail(path, 'must be "https" or "http"');
  return v as 'https' | 'http';
};

function cameraOf(v: unknown, path: string, baseDir: string, env: NodeJS.ProcessEnv): ImportCamera {
  if (!isObj(v)) fail(path, 'must be an object');
  const c = v as Record<string, unknown>;
  const out: ImportCamera = {};
  if (c.id !== undefined) {
    if (typeof c.id !== 'string' || !ID_PATTERN.test(c.id)) fail(`${path}.id`, `must match ${ID_PATTERN}`);
    out.id = c.id as string;
  }
  for (const k of ['name', 'user', 'tlsServername', 'host', 'webUiNote'] as const) if (c[k] !== undefined) out[k] = text(c[k], `${path}.${k}`);
  if (c.password !== undefined) out.password = secret(c.password, `${path}.password`, baseDir, env);
  if (c.protocol !== undefined) out.protocol = protocolOf(c.protocol, `${path}.protocol`);
  if (c.webUiUrl !== undefined) {
    if (c.webUiUrl !== null && !(typeof c.webUiUrl === 'string' && /^https?:\/\/[^\s]+$/.test(c.webUiUrl))) fail(`${path}.webUiUrl`, 'must be an http(s) URL or null');
    out.webUiUrl = c.webUiUrl as string | null;
  }
  return out;
}

export function parseImportInput(input: string, baseDir: string, env: NodeJS.ProcessEnv): ImportProxy[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail('input', 'is not valid JSON');
  }
  if (!isObj(parsed) || !Array.isArray(parsed.proxies) || !parsed.proxies.length) fail('input', 'must be {"proxies": [ … ]} with at least one proxy');
  return ((parsed as { proxies: unknown[] }).proxies).map((raw, i) => {
    const at = `proxies[${i}]`;
    if (!isObj(raw)) fail(at, 'must be an object');
    const p = raw as Record<string, unknown>;
    const out: ImportProxy = {
      url: proxyUrl(p.url, `${at}.url`),
      token: token(p.token, `${at}.token`, baseDir, env),
      cameraUser: text(p.cameraUser, `${at}.cameraUser`)!,
      cameraPassword: secret(p.cameraPassword, `${at}.cameraPassword`, baseDir, env),
      prefix: '',
      cameras: {},
    };
    if (p.tlsServername !== undefined) out.tlsServername = text(p.tlsServername, `${at}.tlsServername`);
    if (p.caFingerprint !== undefined) {
      const pins = fingerprintList(p.caFingerprint);
      if (!pins) fail(`${at}.caFingerprint`, 'must be a SHA-256 fingerprint (64 hex digits, "SHA256:" optional) or a list of them');
      out.caFingerprint = pins!;
    }
    if (p.adminToken !== undefined) out.adminToken = token(p.adminToken, `${at}.adminToken`, baseDir, env);
    if (p.prefix !== undefined) {
      if (typeof p.prefix !== 'string' || !/^[a-z0-9-]{0,16}$/.test(p.prefix)) fail(`${at}.prefix`, 'lowercase letters, digits and dashes, up to 16 characters');
      out.prefix = p.prefix as string;
    }
    if (p.protocol !== undefined) out.protocol = protocolOf(p.protocol, `${at}.protocol`);
    if (p.cameras !== undefined) {
      if (!isObj(p.cameras)) fail(`${at}.cameras`, 'must be an object keyed by the proxy’s camera ids');
      for (const [id, c] of Object.entries(p.cameras as Record<string, unknown>)) {
        if (!ID_PATTERN.test(id)) fail(`${at}.cameras`, `"${id}" is not a camera id`);
        out.cameras[id] = cameraOf(c, `${at}.cameras.${id}`, baseDir, env);
      }
    }
    return out;
  });
}

export interface ProxyCamera {
  id: string; // the proxy's id
  name: string | null;
  address: string | null;
  tls: { mode: string; servername: string | null; fingerprint: string | null } | null; // spec §10.4; null: the proxy has no site CA
}

const shortText = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 64 && !/\p{C}/u.test(v) ? v : null);

function tlsOf(v: unknown): ProxyCamera['tls'] {
  if (!isObj(v) || typeof v.mode !== 'string') return null;
  return { mode: v.mode.slice(0, 16), servername: typeof v.servername === 'string' && /^[a-z0-9.-]{1,253}$/i.test(v.servername) ? v.servername : null, fingerprint: typeof v.fingerprint === 'string' ? v.fingerprint : null };
}

// The cameras a proxy serves (GET /api/cameras with its client token). With
// a pinned site CA: /tls/ca.pem first, checked against the pin, then the
// list over TLS that trusts only that CA (spec §13.3). The token is sent
// only after the pin matched.
export async function readProxyCameras(p: ImportProxy, o: { timeoutMs?: number } = {}): Promise<ProxyCamera[]> {
  const host = new URL(p.url).host;
  const timeoutMs = o.timeoutMs ?? 10_000;
  let dispatcher: Dispatcher | undefined;
  if (p.caFingerprint) {
    try {
      const ca = await fetchPinnedCa(p.url, p.caFingerprint, { timeoutMs });
      dispatcher = siteCaDispatcher([ca.pem], p.tlsServername);
    } catch (err) {
      throw new ImportError(err instanceof SiteCaError ? `proxy ${host}: ${err.message.replace(/^cam-proxy \S+: /, '')}` : `proxy ${host}: ${(err as Error).name}`);
    }
  }
  let res: Response;
  try {
    res = await fetchWith(dispatcher)(`${p.url}/api/cameras`, { headers: { Authorization: `Bearer ${p.token}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ImportError(`proxy ${host}: unreachable (${(err as Error).name})`);
  }
  if (res.status === 401 || res.status === 403) throw new ImportError(`proxy ${host}: refused the token (${res.status})`);
  if (!res.ok) throw new ImportError(`proxy ${host}: answered ${res.status}`);
  let list: unknown;
  try {
    list = await res.json();
  } catch {
    throw new ImportError(`proxy ${host}: its camera list isn't JSON`);
  }
  if (!Array.isArray(list)) throw new ImportError(`proxy ${host}: its camera list isn't a list`);
  return list
    .filter((c): c is Record<string, unknown> => isObj(c) && typeof c.id === 'string' && ID_PATTERN.test(c.id))
    .map((c) => ({ id: c.id as string, name: shortText(c.name), address: validCameraAddress(c.address) ? c.address : null, tls: tlsOf(c.tls) }));
}
