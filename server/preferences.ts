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

async function readAll(): Promise<Record<string, Partial<Preferences>>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ err: (err as Error).message }, 'preferences file unreadable; using defaults');
    return {};
  }
}

export async function getPreferences(email: string): Promise<Preferences> {
  return { ...DEFAULT_PREFERENCES, ...((await readAll())[email.toLowerCase()] ?? {}) };
}

// Writes are serialized and atomic (temp file + rename in the same
// directory), so two saves can't interleave and a crash never leaves half a
// file on the volume. During a rolling deploy the old and new pods both mount
// the volume for a few seconds, and both run as PID 1 in their containers, so
// the temp name needs a random part, not the PID.
export function savePreferences(email: string, patch: Partial<Preferences>): Promise<Preferences> {
  const run = writing.then(async () => {
    const all = await readAll();
    const key = email.toLowerCase();
    const next = { ...DEFAULT_PREFERENCES, ...(all[key] ?? {}), ...patch };
    all[key] = next;
    await fs.mkdir(dirname(file()), { recursive: true });
    const tmp = `${file()}.tmp-${randomBytes(6).toString('hex')}`;
    await fs.writeFile(tmp, JSON.stringify(all, null, 2));
    await fs.rename(tmp, file());
    return next;
  });
  writing = run.catch(() => undefined);
  return run;
}

export function validatePreferencesPatch(body: unknown): { ok: true; patch: Partial<Preferences> } | { ok: false; details: string[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, details: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const details: string[] = [];
  for (const k of Object.keys(b)) if (!(k in DEFAULT_PREFERENCES)) details.push(`${k}: unknown field`);
  if ('defaultCamera' in b && b.defaultCamera !== null && !(typeof b.defaultCamera === 'string' && getCamera(b.defaultCamera))) details.push('defaultCamera: a configured camera id or null');
  if ('liveQuality' in b && b.liveQuality !== 'sub' && b.liveQuality !== 'main') details.push('liveQuality: sub or main');
  if ('eventFilter' in b && !['all', 'person', 'vehicle', 'pet', 'motion'].includes(b.eventFilter as string)) details.push('eventFilter: all, person, vehicle, pet or motion');
  if ('timelineZoom' in b && ![24, 6, 1].includes(b.timelineZoom as number)) details.push('timelineZoom: 24, 6 or 1');
  if ('liveKeepAlive' in b && !(KEEP_ALIVE_CHOICES as readonly number[]).includes(b.liveKeepAlive as number)) details.push('liveKeepAlive: 0, 30, 60, 120, 300 or 900');
  return details.length ? { ok: false, details } : { ok: true, patch: b as Partial<Preferences> };
}
