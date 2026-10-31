import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { readFileSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { logger } from '../logger';
import { fleetCamera, fleetCameras, type CamKey } from '../fleet';
import { credentialsWritable, hasCameraPassword, loadCredentials, removeCameraPassword } from '../credentials';

// The per-proxy switch to camera calls through the proxy (cam-proxy spec
// 2026-10-30-camera-onboarding-design §6.1, §8): a camera whose proxy (by
// account and URL) last listed `camera-calls` in an item's `features` is
// reached only through that proxy. Kept in a small file so a restart with the
// proxy down still knows it: PROXY_FEATURES_FILE, else proxy-features.json in
// PREFS_FILE's folder, else the temp folder. The file holds neither the URL
// nor a token, only a hash of account and URL.

export const CAMERA_CALLS = 'camera-calls';

export const proxyFeaturesFile = (): string =>
  process.env.PROXY_FEATURES_FILE ||
  (process.env.PREFS_FILE ? join(dirname(process.env.PREFS_FILE), 'proxy-features.json') : join(tmpdir(), 'cams-proxy-features.json'));

interface Entry { features: string[]; at: number }
interface FileShape { v: 1; proxies: Record<string, Entry> }

let state: FileShape = { v: 1, proxies: {} };
let writing: Promise<unknown> = Promise.resolve();

// 'through' {accountId, proxyUrl, on}: `camera-calls` came or went for a proxy.
export const featureEvents = new EventEmitter();
featureEvents.setMaxListeners(0);

const FEATURE = /^[a-z0-9-]{1,32}$/;
const MAX_FEATURES = 32;
const normUrl = (url: string): string => url.replace(/\/+$/, '');
const keyOf = (accountId: string, proxyUrl: string): string => createHash('sha256').update(`${accountId}\u0000${normUrl(proxyUrl)}`).digest('hex').slice(0, 32);

const validEntry = (v: unknown): v is Entry =>
  typeof v === 'object' && v !== null && Array.isArray((v as Entry).features) && (v as Entry).features.every((f) => typeof f === 'string' && FEATURE.test(f)) && Number.isFinite((v as Entry).at);

// Read once at start. A missing or bad file is empty (every camera direct
// until its proxy's list is read).
export function loadProxyFeatures(): void {
  state = { v: 1, proxies: {} };
  let text: string;
  try {
    text = readFileSync(proxyFeaturesFile(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ message: (err as Error).message }, 'proxy_features_unreadable');
    return;
  }
  try {
    const parsed = JSON.parse(text) as Partial<FileShape> | null;
    if (!parsed || parsed.v !== 1 || typeof parsed.proxies !== 'object' || parsed.proxies === null) throw new Error('not a features file');
    for (const [k, e] of Object.entries(parsed.proxies)) if (/^[0-9a-f]{32}$/.test(k) && validEntry(e)) state.proxies[k] = { features: e.features.slice(0, MAX_FEATURES), at: e.at };
  } catch (err) {
    logger.warn({ message: (err as Error).message }, 'proxy_features_corrupt');
  }
}

// The union of the items' `features` (valid names only, at most 32).
function featuresOf(list: unknown): string[] {
  const out = new Set<string>();
  if (!Array.isArray(list)) return [];
  for (const item of list) {
    const f = (item as { features?: unknown } | null)?.features;
    if (!Array.isArray(f)) continue;
    for (const x of f) if (typeof x === 'string' && FEATURE.test(x) && out.size < MAX_FEATURES) out.add(x);
  }
  return [...out].sort();
}

async function write(next: FileShape): Promise<void> {
  const target = proxyFeaturesFile();
  await fs.mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next));
  await fs.rename(tmp, target).catch(async (err: unknown) => {
    await fs.rm(tmp, { force: true });
    throw err;
  });
}

// A successful read of a proxy's camera list (GET /api/cameras). Written
// only when the features changed; a flip of `camera-calls` is announced.
export function noteProxyFeatures(accountId: string, proxyUrl: string, list: unknown): Promise<void> {
  const run = writing.then(async () => {
    const key = keyOf(accountId, proxyUrl);
    const features = featuresOf(list);
    const before = state.proxies[key];
    if (before && JSON.stringify(before.features) === JSON.stringify(features)) return;
    const next: FileShape = { v: 1, proxies: { ...state.proxies, [key]: { features, at: Date.now() } } };
    try {
      await write(next);
    } catch (err) {
      // Kept in memory: the switch still follows the proxy until a restart.
      logger.warn({ message: (err as Error).message }, 'proxy_features_unwritable');
    }
    state = next;
    const was = !!before?.features.includes(CAMERA_CALLS);
    const on = features.includes(CAMERA_CALLS);
    if (was !== on) {
      logger.info({ accountId, on }, 'proxy_camera_calls');
      featureEvents.emit('through', { accountId, proxyUrl: normUrl(proxyUrl), on });
    }
  });
  writing = run.catch(() => undefined);
  return run;
}

export function throughProxyAt(accountId: string, proxyUrl: string): boolean {
  return !!state.proxies[keyOf(accountId, proxyUrl)]?.features.includes(CAMERA_CALLS);
}

// The camera has a proxy and that proxy announces camera calls.
export function throughProxy(id: CamKey): boolean {
  const cam = fleetCamera(id);
  return !!cam?.proxy && throughProxyAt(cam.accountId, cam.proxy.url);
}

// No camera password for a camera reached through its proxy (spec 2026-10-30
// §6.2, §8): its entry in the local credentials file is removed when the
// file is writable (the Pi); a read-only one (the cluster's Secret) is only
// reported, once per camera, and left to kube-setup. `only`: one proxy's
// cameras (its switch just turned on); none: every through-proxy camera (start).
const leftReported = new Set<CamKey>();
export async function cleanupProxiedPasswords(only?: { accountId: string; proxyUrl: string }): Promise<void> {
  try {
    loadCredentials();
  } catch (err) {
    logger.warn({ message: (err as Error).message }, 'camera_password_cleanup_skipped');
    return;
  }
  for (const c of fleetCameras()) {
    if (!c.proxy || !throughProxyAt(c.accountId, c.proxy.url)) continue;
    if (only && (c.accountId !== only.accountId || normUrl(c.proxy.url) !== normUrl(only.proxyUrl))) continue;
    if (!hasCameraPassword(c.accountId, c.camsId)) continue;
    if (!credentialsWritable()) {
      if (!leftReported.has(c.id)) {
        leftReported.add(c.id);
        logger.info({ cameraId: c.id, reason: 'read_only' }, 'camera_password_left');
      }
      continue;
    }
    try {
      if (await removeCameraPassword(c.accountId, c.camsId)) logger.info({ cameraId: c.id }, 'camera_password_removed');
    } catch (err) {
      logger.warn({ cameraId: c.id, message: (err as Error).message }, 'camera_password_remove_failed');
    }
  }
}

featureEvents.on('through', (e: { accountId: string; proxyUrl: string; on: boolean }) => {
  if (e.on) void cleanupProxiedPasswords(e);
});
