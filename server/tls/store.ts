import { EventEmitter } from 'events';
import { readFileSync, statSync, promises as fs } from 'fs';
import { basename, dirname, join } from 'path';
import { allCameras } from '../cameraRegistry';
import { logger } from '../logger';
import { certFingerprint, normalizeFingerprint } from './fingerprint';

// What cams keeps of its cam-proxies' TLS (cam-proxy spec 2026-10-05
// §10.1.4, §12.3): every site CA it verified against a pin (fingerprint →
// PEM), and the fallback leaf pins its proxies reported (cams camera id →
// {fingerprint, host}: a pin is for the address it was reported for). Kept
// on disk, so a camera stays reachable while its proxy is away:
// PROXY_TLS_FILE, else proxy-tls.json next to the preferences (the cams-data
// volume). Nothing in it is secret, but it is integrity-critical: a planted
// CA or pin would let another host take the camera login (it carries the
// password). So never the temp folder, and a file another user owns or could
// write is refused at start (security review of PR #227).
const file = (): string | undefined =>
  process.env.PROXY_TLS_FILE || (process.env.PREFS_FILE ? join(dirname(process.env.PREFS_FILE), 'proxy-tls.json') : undefined);

export interface FallbackPin { fingerprint: string; host: string }

let cas = new Map<string, string>();
let pins = new Map<string, FallbackPin>();
let writing: Promise<unknown> = Promise.resolve();

// 'trust' {cam}: a camera's trust changed (a CA verified, a pin set or
// cleared): its direct client is built again.
export const trustEvents = new EventEmitter();
trustEvents.setMaxListeners(0);

const fingerprintOf = (pem: string): string | null => {
  try {
    return certFingerprint(pem);
  } catch {
    return null;
  }
};

export function loadTlsState(): void {
  cas = new Map();
  pins = new Map();
  const path = file();
  if (!path) {
    if (allCameras().some((c) => c.proxy?.caFingerprint)) throw new Error('a cam-proxy caFingerprint needs a data folder for proxy-tls.json: set PROXY_TLS_FILE or PREFS_FILE');
    return; // no pinned proxy: nothing is ever kept
  }
  let text: string;
  try {
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) {
      throw Object.assign(new Error(`${basename(path)} must be mode 600 and owned by this user (it holds the pinned CAs and camera pins); fix or delete it`), { code: 'EPERM_TLS_STATE' });
    }
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM_TLS_STATE') throw err;
    if (code !== 'ENOENT') logger.warn({ message: (err as Error).message }, 'proxy_tls_state_unreadable');
    return;
  }
  try {
    const parsed = JSON.parse(text) as { cas?: Record<string, unknown>; pins?: Record<string, unknown> };
    // Re-checked: a CA is kept only under its own fingerprint.
    for (const [fp, pem] of Object.entries(parsed.cas ?? {})) if (typeof pem === 'string' && fingerprintOf(pem) === fp) cas.set(fp, pem);
    for (const [cam, v] of Object.entries(parsed.pins ?? {})) {
      const p = (typeof v === 'object' && v !== null ? v : {}) as { fingerprint?: unknown; host?: unknown };
      const n = normalizeFingerprint(p.fingerprint);
      if (n && typeof p.host === 'string' && p.host) pins.set(cam, { fingerprint: n, host: p.host });
    }
  } catch (err) {
    logger.warn({ message: (err as Error).message }, 'proxy_tls_state_corrupt');
  }
}

// Serialized, atomic (temp file, then rename), mode 600. A failed write is
// logged: the state in memory still holds until the next start.
function save(): Promise<void> {
  const run = writing.then(async () => {
    const target = file();
    if (!target) return; // no data folder: only possible without a pinned proxy
    await fs.mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ cas: Object.fromEntries(cas), pins: Object.fromEntries(pins) }), { mode: 0o600 });
    await fs.rename(tmp, target).catch(async (err: unknown) => {
      await fs.rm(tmp, { force: true });
      throw err;
    });
  });
  writing = run.catch((err: unknown) => logger.warn({ message: (err as Error).message }, 'proxy_tls_state_unwritten'));
  return writing as Promise<void>;
}

export const verifiedCas = (want: string[]): string[] => want.flatMap((fp) => (cas.has(fp) ? [cas.get(fp)!] : []));

export async function addVerifiedCa(fingerprint: string, pem: string): Promise<void> {
  if (cas.get(fingerprint) === pem) return;
  cas.set(fingerprint, pem);
  await save();
}

// The pin for this camera at this address (none for another address: a
// camera moved or replaced waits for its proxy's report).
export const fallbackPin = (cam: string, host: string | undefined): string | undefined => {
  const p = pins.get(cam);
  return p && host !== undefined && p.host === host ? p.fingerprint : undefined;
};

export async function setFallbackPin(cam: string, pin: FallbackPin | null): Promise<void> {
  const now = pins.get(cam);
  if (now?.fingerprint === pin?.fingerprint && now?.host === pin?.host) return;
  if (pin) pins.set(cam, { fingerprint: pin.fingerprint, host: pin.host });
  else pins.delete(cam);
  await save();
  trustEvents.emit('trust', { cam });
}
