import { readFileSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { logger } from './logger';

// The per-camera "use cam-proxy" switch, for all users: `{ "<cameraId>": false }`
// for cameras switched off; a camera not listed uses its proxy. Kept in a
// file next to the preferences (one cams pod, so no other copy to sync):
// PROXY_STATE_FILE, else proxy-state.json in PREFS_FILE's folder (the cams-data
// volume in the cluster), else the temp folder.
const file = () =>
  process.env.PROXY_STATE_FILE ||
  (process.env.PREFS_FILE ? join(dirname(process.env.PREFS_FILE), 'proxy-state.json') : join(tmpdir(), 'cams-proxy-state.json'));
let off = new Set<string>();
let writing: Promise<unknown> = Promise.resolve();

// Read once at startup. A missing or unreadable file means every proxy is on.
export function loadProxyState(): void {
  off = new Set();
  let text: string;
  try {
    text = readFileSync(file(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ message: (err as Error).message }, 'proxy_state_unreadable');
    return;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    for (const [id, v] of Object.entries(parsed)) if (v === false) off.add(id);
  } catch (err) {
    logger.warn({ message: (err as Error).message }, 'proxy_state_corrupt');
  }
}

export function proxyEnabled(cameraId: string): boolean {
  return !off.has(cameraId);
}

// Writes are serialized and atomic (temp file, then rename). The new value
// takes effect only once it is on disk, so a failed write changes nothing.
export function setProxyEnabled(cameraId: string, enabled: boolean): Promise<void> {
  const run = writing.then(async () => {
    const next = new Set(off);
    if (enabled) next.delete(cameraId);
    else next.add(cameraId);
    const target = file();
    await fs.mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries([...next].sort().map((id) => [id, false]))));
    await fs.rename(tmp, target).catch(async (err: unknown) => {
      await fs.rm(tmp, { force: true });
      throw err;
    });
    off = next;
  });
  writing = run.catch(() => undefined);
  return run;
}
