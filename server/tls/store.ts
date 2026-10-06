import { EventEmitter } from 'events';
import { readFileSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { logger } from '../logger';
import { certFingerprint, normalizeFingerprint } from './fingerprint';

// What cams keeps of its cam-proxies' TLS (cam-proxy spec 2026-10-05
// §10.1.4, §12.3): every site CA it verified against a pin (fingerprint →
// PEM), and the fallback leaf pins its proxies reported (cams camera id →
// fingerprint). Kept on disk, so a camera stays reachable while its proxy is
// away: PROXY_TLS_FILE, else proxy-tls.json next to the preferences (the
// cams-data volume), else the temp folder. Nothing in it is secret.
const file = () =>
  process.env.PROXY_TLS_FILE ||
  (process.env.PREFS_FILE ? join(dirname(process.env.PREFS_FILE), 'proxy-tls.json') : join(tmpdir(), 'cams-proxy-tls.json'));

let cas = new Map<string, string>();
let pins = new Map<string, string>();
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
  let text: string;
  try {
    text = readFileSync(file(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ message: (err as Error).message }, 'proxy_tls_state_unreadable');
    return;
  }
  try {
    const parsed = JSON.parse(text) as { cas?: Record<string, unknown>; pins?: Record<string, unknown> };
    // Re-checked: a CA is kept only under its own fingerprint.
    for (const [fp, pem] of Object.entries(parsed.cas ?? {})) if (typeof pem === 'string' && fingerprintOf(pem) === fp) cas.set(fp, pem);
    for (const [cam, fp] of Object.entries(parsed.pins ?? {})) {
      const n = normalizeFingerprint(fp);
      if (n) pins.set(cam, n);
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

export const fallbackPin = (cam: string): string | undefined => pins.get(cam);

export async function setFallbackPin(cam: string, fingerprint: string | null): Promise<void> {
  if ((pins.get(cam) ?? null) === fingerprint) return;
  if (fingerprint) pins.set(cam, fingerprint);
  else pins.delete(cam);
  await save();
  trustEvents.emit('trust', { cam });
}
