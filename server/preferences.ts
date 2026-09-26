import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { getCamera } from './cameraRegistry';
import { logger } from './logger';

export interface Preferences {
  defaultCamera: string | null;
  liveQuality: 'sub' | 'main';
  eventFilter: 'all' | 'person' | 'vehicle' | 'pet' | 'motion';
  timelineZoom: 24 | 6 | 1;
  liveKeepAlive: 0 | 30 | 60 | 120 | 300 | 900; // seconds; 0 = off
}

export const KEEP_ALIVE_CHOICES = [0, 30, 60, 120, 300, 900] as const;
export const DEFAULT_PREFERENCES: Preferences = { defaultCamera: null, liveQuality: 'sub', eventFilter: 'all', timelineZoom: 24, liveKeepAlive: 60 };

const file = () => process.env.PREFS_FILE || join(tmpdir(), 'cams-preferences.json');
let writing: Promise<unknown> = Promise.resolve();

// Thrown by a save when the file exists but isn't a JSON object: writing it
// back would replace every other user's preferences with just this one.
class CorruptPreferencesError extends Error {
  constructor() {
    super('preferences file is corrupt; refusing to overwrite it');
    this.name = 'CorruptPreferencesError';
  }
}

// `forSave`: a corrupt file throws instead of reading as empty. Reads for
// display still fall back to defaults.
async function readAll(forSave = false): Promise<Record<string, Partial<Preferences>>> {
  let text: string;
  try {
    text = await fs.readFile(file(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}; // first save ever
    // Unreadable (EACCES, EIO…): never overwrite it with one user's data.
    if (forSave) {
      logger.error({ err: (err as Error).message }, 'preferences file unreadable; refusing to save over it');
      throw new CorruptPreferencesError();
    }
    logger.warn({ err: (err as Error).message }, 'preferences file unreadable; using defaults');
    return {};
  }
  // An empty file (e.g. left by a crash before writes were fsynced) holds no
  // preferences; treat it as none rather than blocking every save.
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, Partial<Preferences>>;
  if (forSave) {
    logger.error('preferences file is corrupt; refusing to save over it');
    throw new CorruptPreferencesError();
  }
  logger.warn('preferences file is corrupt; using defaults');
  return {};
}

// What's stored may come from an older version or a hand edit: keep only
// known fields whose values are still valid (a removed camera, for one).
function sanitize(stored: unknown): Partial<Preferences> {
  const out: Record<string, unknown> = {};
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return out;
  for (const k of Object.keys(DEFAULT_PREFERENCES)) {
    if (!Object.prototype.hasOwnProperty.call(stored, k)) continue;
    const v = (stored as Record<string, unknown>)[k];
    if (validatePreferencesPatch({ [k]: v }).ok) out[k] = v;
  }
  return out as Partial<Preferences>;
}

export async function getPreferences(email: string): Promise<Preferences> {
  return { ...DEFAULT_PREFERENCES, ...sanitize((await readAll())[email.toLowerCase()]) };
}

// Writes are serialized and atomic (temp file, fsync, rename in the same
// directory), so two saves can't interleave and a crash never leaves half a
// file on the volume. During a rolling deploy the old and new pods both mount
// the volume for a few seconds, and both run as PID 1 in their containers, so
// the temp name needs a random part, not the PID.
export function savePreferences(email: string, patch: Partial<Preferences>): Promise<Preferences> {
  const run = writing.then(async () => {
    const all = await readAll(true);
    const key = email.toLowerCase();
    const next = { ...DEFAULT_PREFERENCES, ...sanitize(all[key]), ...patch };
    all[key] = next;
    await fs.mkdir(dirname(file()), { recursive: true });
    const tmp = `${file()}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      // Synced before the rename, so a crash right after it can't leave the
      // new name pointing at a file whose data never reached the disk.
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.writeFile(JSON.stringify(all, null, 2));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, file());
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    return next;
  });
  writing = run.catch(() => undefined);
  return run;
}

export function validatePreferencesPatch(body: unknown): { ok: true; patch: Partial<Preferences> } | { ok: false; details: string[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, details: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const details: string[] = [];
  // Own keys only: `in` would accept inherited names such as 'toString'.
  for (const k of Object.keys(b)) if (!Object.prototype.hasOwnProperty.call(DEFAULT_PREFERENCES, k)) details.push(`${k}: unknown field`);
  if ('defaultCamera' in b && b.defaultCamera !== null && !(typeof b.defaultCamera === 'string' && getCamera(b.defaultCamera))) details.push('defaultCamera: a configured camera id or null');
  if ('liveQuality' in b && b.liveQuality !== 'sub' && b.liveQuality !== 'main') details.push('liveQuality: sub or main');
  if ('eventFilter' in b && !['all', 'person', 'vehicle', 'pet', 'motion'].includes(b.eventFilter as string)) details.push('eventFilter: all, person, vehicle, pet or motion');
  if ('timelineZoom' in b && ![24, 6, 1].includes(b.timelineZoom as number)) details.push('timelineZoom: 24, 6 or 1');
  if ('liveKeepAlive' in b && !(KEEP_ALIVE_CHOICES as readonly number[]).includes(b.liveKeepAlive as number)) details.push('liveKeepAlive: 0, 30, 60, 120, 300 or 900');
  return details.length ? { ok: false, details } : { ok: true, patch: b as Partial<Preferences> };
}
