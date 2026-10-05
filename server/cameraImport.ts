// The cameras.json generator (cam-proxy spec 2026-10-05 §13.3): from a short
// list of cam-proxies, one cams camera per camera each proxy serves. A
// library, so a later "Add proxy" in cams can use it (§13.4);
// scripts/cameras-config.ts is its command line. It never prints a secret:
// errors name a field, diffs show •••.
import { promises as fs, readFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import type { Dispatcher } from 'undici';
import { FROM_PROXY, parseCameras, validCameraAddress } from './cameraRegistry';
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

export type Entry = Record<string, unknown>;
export interface BuildResult { entries: Entry[]; notes: string[] }

const SECRETS = new Set(['password', 'token', 'adminToken']);
const urlKey = (u: unknown) => String(u).replace(/\/+$/, '');
const hostOf = (u: string) => new URL(u).host;
const remoteOf = (e: Entry): string | undefined => {
  const p = e.proxy as Entry | undefined;
  return p ? ((p.camera as string | undefined) ?? (e.id as string)) : undefined;
};

function entryFor(p: ImportProxy, c: ProxyCamera, old: Entry | undefined): Entry {
  const input = p.cameras[c.id] ?? {};
  const where = `proxy ${hostOf(p.url)} camera ${c.id}`;
  let host: string, protocol: 'https' | 'http', tlsServername: string | undefined;
  if (p.caFingerprint) {
    host = FROM_PROXY;
    protocol = 'https';
    tlsServername = input.tlsServername ?? c.tls?.servername ?? undefined;
  } else {
    protocol = input.protocol ?? p.protocol ?? 'https';
    tlsServername = input.tlsServername;
    const h = input.host ?? (protocol === 'https' && tlsServername ? FROM_PROXY : c.address);
    if (!h) throw new ImportError(`${where}: no address (the proxy reports none): set "host", or "tlsServername" for "from-proxy"`);
    host = h;
  }
  const webUiUrl = input.webUiUrl !== undefined ? input.webUiUrl : old?.webUiUrl;
  const webUiNote = input.webUiNote ?? old?.webUiNote;
  const pins = p.caFingerprint;
  return {
    id: (old?.id as string | undefined) ?? input.id ?? `${p.prefix}${c.id}`,
    name: (old?.name as string | undefined) ?? input.name ?? c.name ?? input.id ?? `${p.prefix}${c.id}`,
    host,
    protocol,
    ...(tlsServername && { tlsServername }),
    user: input.user ?? p.cameraUser,
    password: input.password ?? p.cameraPassword,
    ...(webUiUrl !== undefined && { webUiUrl }),
    ...(webUiNote !== undefined && { webUiNote }),
    proxy: {
      url: p.url,
      token: p.token,
      ...(p.adminToken && { adminToken: p.adminToken }),
      camera: c.id,
      ...(p.tlsServername && { tlsServername: p.tlsServername }),
      ...(pins && { caFingerprint: pins.length === 1 ? pins[0] : pins }),
    },
  };
}

export function buildCameras(existing: Entry[], read: { proxy: ImportProxy; cameras: ProxyCamera[] }[], o: { prune: boolean }): BuildResult {
  const notes: string[] = [];
  const out: (Entry | null)[] = existing.map((e) => e); // null: dropped
  const source = new Map<number, string>(); // out index → where it comes from (for collisions)
  existing.forEach((e, i) => source.set(i, e.proxy ? `existing entry for proxy ${hostOf(urlKey((e.proxy as Entry).url))} camera ${remoteOf(e)}` : 'an existing entry without this proxy'));
  for (const { proxy: p, cameras } of read) {
    const listed = new Set(cameras.map((c) => c.id));
    for (const c of cameras) {
      const i = existing.findIndex((e) => e.proxy && urlKey((e.proxy as Entry).url) === p.url && remoteOf(e) === c.id);
      const old = i >= 0 ? existing[i] : undefined;
      const entry = entryFor(p, c, old);
      const asked = p.cameras[c.id]?.id;
      if (old && asked && asked !== old.id) notes.push(`${old.id}: kept its id (the input asks for "${asked}"; rename by hand)`);
      if (i >= 0) out[i] = entry;
      else {
        out.push(entry);
        source.set(out.length - 1, `proxy ${hostOf(p.url)} camera ${c.id}`);
      }
      if (i >= 0) source.set(i, `proxy ${hostOf(p.url)} camera ${c.id}`);
    }
    existing.forEach((e, i) => {
      if (!e.proxy || urlKey((e.proxy as Entry).url) !== p.url || listed.has(remoteOf(e)!)) return;
      const why = `proxy ${hostOf(p.url)} no longer lists camera ${remoteOf(e)}`;
      if (o.prune) {
        out[i] = null;
        notes.push(`${e.id}: dropped (${why})`);
      } else notes.push(`${e.id}: ${why} (kept; --prune drops it)`);
    });
  }
  const entries: Entry[] = [];
  const seen = new Map<string, number>();
  out.forEach((e, i) => {
    if (!e) return;
    const first = seen.get(e.id as string);
    if (first !== undefined) throw new ImportError(`id "${e.id}" is used by ${source.get(first)} and ${source.get(i)}: give one an "id" or a "prefix"`);
    seen.set(e.id as string, i);
    entries.push(e);
  });
  try {
    parseCameras(entries, 'the generated cameras.json');
  } catch (err) {
    throw new ImportError(`the result would not load in cams: ${(err as Error).message}`);
  }
  return { entries, notes };
}

// Field by field, secrets as •••.
function flat(e: Entry, prefix = ''): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const [k, v] of Object.entries(e)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [kk, vv] of flat(v as Entry, `${prefix}${k}.`)) m.set(kk, vv);
    else m.set(`${prefix}${k}`, v);
  }
  return m;
}
const shown = (path: string, v: unknown) => (v === undefined ? '(none)' : SECRETS.has(path.split('.').at(-1)!) ? '•••' : JSON.stringify(v));
const masked = (e: Entry): Entry => JSON.parse(JSON.stringify(e, (k, v) => (SECRETS.has(k) && typeof v === 'string' ? '•••' : v)));

export function diffCameras(before: Entry[], after: Entry[]): string[] {
  const lines: string[] = [];
  const old = new Map(before.map((e) => [e.id as string, e]));
  const now = new Set(after.map((e) => e.id as string));
  for (const e of after) {
    const b = old.get(e.id as string);
    if (!b) {
      lines.push(`+ ${e.id}: ${JSON.stringify(masked(e))}`);
      continue;
    }
    const fb = flat(b), fa = flat(e);
    for (const k of new Set([...fb.keys(), ...fa.keys()])) {
      if (JSON.stringify(fb.get(k)) !== JSON.stringify(fa.get(k))) lines.push(`~ ${e.id}: ${k} ${shown(k, fb.get(k))} → ${shown(k, fa.get(k))}`);
    }
  }
  for (const e of before) if (!now.has(e.id as string)) lines.push(`- ${e.id}`);
  return lines;
}

const USAGE = 'usage: cameras-config [--output cameras.json] [--input cameras-config.json] [--write] [--prune]';
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// The command line (scripts/cameras-config.ts). 0: done; 1: refused (nothing
// written); 2: usage. Every proxy is read before anything is written.
export async function runCamerasConfig(argv: string[], env: NodeJS.ProcessEnv, io: { out: (line: string) => void; err: (line: string) => void }, now: () => Date = () => new Date()): Promise<number> {
  let output = 'cameras.json', input: string | undefined, write = false, prune = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') write = true;
    else if (a === '--prune') prune = true;
    else if ((a === '--output' || a === '--input') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      if (a === '--output') output = argv[++i];
      else input = argv[++i];
    } else return io.err(USAGE), 2;
  }
  output = resolve(output);
  input = resolve(input ?? join(dirname(output), 'cameras-config.json'));
  try {
    const st = await fs.stat(input).catch(() => {
      throw new ImportError(`${input} not found`);
    });
    if (st.mode & 0o077) throw new ImportError(`${input} is readable by others: chmod 600 it (it holds tokens and passwords)`);
    const proxies = parseImportInput(await fs.readFile(input, 'utf8'), dirname(input), env);
    let existing: Entry[] = [];
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(output, 'utf8'));
      if (!Array.isArray(parsed)) throw new ImportError(`${output} is not a JSON array`);
      existing = parsed as Entry[];
    } catch (err) {
      if (err instanceof ImportError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new ImportError(`${output} is not valid JSON`);
    }
    const read = [];
    for (const proxy of proxies) read.push({ proxy, cameras: await readProxyCameras(proxy) });
    const { entries, notes } = buildCameras(existing, read, { prune });
    const lines = diffCameras(existing, entries);
    for (const l of lines.length ? lines : ['(no changes)']) io.out(l);
    for (const n of notes) io.out(`note: ${n}`);
    if (!write) return io.out(`Dry run: nothing written. Run again with --write to write ${output}.`), 0;
    if (!lines.length) return io.out('Nothing to write.'), 0;
    const tmp = `${output}.tmp-${process.pid}`;
    try {
      await fs.writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      if (existing.length || (await fs.stat(output).then(() => true, () => false))) {
        const bak = `${output}.bak-${stamp(now())}`;
        await fs.copyFile(output, bak);
        await fs.chmod(bak, 0o600);
      }
      await fs.rename(tmp, output);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw new ImportError(`could not write ${output} (${(err as NodeJS.ErrnoException).code ?? (err as Error).name})`);
    }
    io.out(`Wrote ${output} (${entries.length} cameras).`);
    return 0;
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    io.err(err.message);
    return 1;
  }
}
