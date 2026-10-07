// Camera credentials (migration P4, M §9.8): camera passwords never come
// from cams-admin. cams reads them from CAMERA_CREDENTIALS_FILE
// (`{"v": 1, "<account name>/<camsId>": {"user", "password"}}`, mode 600;
// the cluster's cams-camera-credentials Secret), else — during the
// transition, for the file account only — from the same id in CAMERAS_FILE.
// The user name comes from cams-admin; a different one here is a mismatch,
// shown, never guessed. Nothing here is ever logged.
import { accessSync, constants, readFileSync, statSync, promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { basename, dirname } from 'path';
import type { FileCameraConfig } from './cameraRegistry';
import { fileAccount } from './fleet';

export type CredentialResult = { ok: true; user: string; password: string } | { ok: false; problem: 'missing' | 'mismatch'; user: string | null };
interface Entry { user: string; password: string }

let entries = new Map<string, Entry>();
let legacy: FileCameraConfig[] = [];
let writing: Promise<unknown> = Promise.resolve();
const file = () => process.env.CAMERA_CREDENTIALS_FILE || '';

// CAMERAS_FILE's cameras (the transition fallback), set by the config start.
export function setLegacyCredentials(list: FileCameraConfig[]): void {
  legacy = list;
}

const bad = (why: string) => new Error(`CAMERA_CREDENTIALS_FILE (${basename(file())}) ${why}`);

// Read at start (and after a save). A missing file is empty; one others can
// read, or a malformed one, stops the start (it holds camera passwords).
export function loadCredentials(): void {
  entries = new Map();
  const f = file();
  if (!f) return;
  let text: string;
  try {
    const st = statSync(f);
    if ((st.mode & 0o077) !== 0) throw bad('must be mode 600 (it holds camera passwords)');
    text = readFileSync(f, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    if ((err as Error).message.startsWith('CAMERA_CREDENTIALS_FILE')) throw err;
    throw bad('is not readable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad('is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { v?: unknown }).v !== 1) throw bad('must be {"v": 1, "<account>/<camera>": {"user", "password"}}');
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k === 'v') continue;
    const e = v as Partial<Entry> | null;
    if (!/^[^/\s]{1,64}\/[a-z0-9][a-z0-9-]{0,31}$/.test(k) || !e || typeof e.user !== 'string' || !e.user || typeof e.password !== 'string' || !e.password) throw bad('has an entry that is not {"user", "password"}');
    entries.set(k, { user: e.user, password: e.password });
  }
}

export function credentialsFor(accountName: string, camsId: string, cameraUser: string | null): CredentialResult {
  const e = entries.get(`${accountName}/${camsId}`) ?? (accountName === fileAccount().name ? legacy.find((c) => c.id === camsId) : undefined);
  if (!e) return { ok: false, problem: 'missing', user: cameraUser };
  if (cameraUser !== null && cameraUser !== e.user) return { ok: false, problem: 'mismatch', user: cameraUser };
  return { ok: true, user: e.user, password: e.password };
}

// Whether a password typed in cams can be saved (the Pi); a mounted Secret
// in the cluster is read-only.
export function credentialsWritable(): boolean {
  const f = file();
  if (!f) return false;
  try {
    accessSync(dirname(f), constants.W_OK);
    try {
      accessSync(f, constants.W_OK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Atomic (temp 600, fsync, rename), the other entries kept.
export function setCameraPassword(accountName: string, camsId: string, user: string, password: string): Promise<void> {
  const run = writing.then(async () => {
    const f = file();
    if (!f) throw bad('is not set');
    loadCredentials();
    entries.set(`${accountName}/${camsId}`, { user, password });
    const out: Record<string, unknown> = { v: 1 };
    for (const k of [...entries.keys()].sort()) out[k] = entries.get(k);
    const tmp = `${f}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      const fh = await fs.open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(JSON.stringify(out, null, 2));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, f);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  });
  writing = run.catch(() => undefined);
  return run;
}
