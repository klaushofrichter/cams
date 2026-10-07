import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { resolveCamera } from './cameraRegistry';
import { fileAccount, type AccountRef } from './fleet';
import { logger } from './logger';
import { asAccountLayout, backupOnce, claimsAccountLayout, entryFor, isFileAccount, toAccounts, withEntry, type Loaded } from './stateLayout';

type AllPrefs = Record<string, Partial<Preferences>>;
const isPrefsMap = (v: unknown): v is AllPrefs => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Preferences {
  defaultCamera: string | null; // null: the last camera used (Klaus, 2026-09-28)
  lastCamera: string | null; // remembered on every camera switch
  liveQuality: 'sub' | 'main';
  eventFilter: EventKind[]; // shown kinds, several at once; all four is "All" (Klaus, 2026-09-28)
  timelineZoom: number; // hours, one of TIMELINE_ZOOMS
  liveKeepAlive: 0 | 30 | 60 | 120 | 300 | 900; // seconds; 0 = off
  liveEvents: boolean; // new events at once, with a notification (Klaus, 2026-09-28)
  liveEventTypes: ('person' | 'vehicle' | 'pet' | 'motion')[]; // which ones notify
}

type EventKind = 'person' | 'vehicle' | 'pet' | 'motion';
const KINDS: EventKind[] = ['person', 'vehicle', 'pet', 'motion'];
// A list of kinds (any order, no repeats), or an older version's single
// value ('all' or one kind): always stored as a list in KINDS order.
function eventFilterOf(v: unknown): EventKind[] | null {
  if (v === 'all') return [...KINDS];
  if (typeof v === 'string') return (KINDS as string[]).includes(v) ? [v as EventKind] : null;
  if (!Array.isArray(v) || v.length === 0 || new Set(v).size !== v.length || !v.every((k) => (KINDS as unknown[]).includes(k))) return null;
  return KINDS.filter((k) => v.includes(k));
}

// The History strip's zooms in hours: 24 h to 1 min (Klaus, 2026-10-04: no
// 12 h; 10 min and 1 min added). A 12 h saved earlier, or sent by a page
// loaded before that, is taken as 6 h. Matched within a hair, since 1/6 and
// 1/60 are no exact decimals.
export const TIMELINE_ZOOMS = [24, 6, 3, 1, 0.5, 1 / 6, 1 / 60] as const;
function timelineZoomOf(v: unknown): number | null {
  if (v === 12) return 6;
  if (typeof v !== 'number') return null;
  return TIMELINE_ZOOMS.find((z) => Math.abs(z - v) < 1e-6) ?? null;
}

export const KEEP_ALIVE_CHOICES = [0, 30, 60, 120, 300, 900] as const;
export const DEFAULT_PREFERENCES: Preferences = { defaultCamera: null, lastCamera: null, liveQuality: 'sub', eventFilter: ['person', 'vehicle', 'pet', 'motion'], timelineZoom: 24, liveKeepAlive: 60, liveEvents: true, liveEventTypes: ['person', 'vehicle', 'pet', 'motion'] };

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
// display still fall back to defaults. Either layout (server/stateLayout.ts):
// the old one is the file account's; a missing file reads as the old one.
const EMPTY = (): Loaded<AllPrefs> => ({ layout: 'old', data: {} });
async function readAll(forSave = false): Promise<Loaded<AllPrefs>> {
  let text: string;
  try {
    text = await fs.readFile(file(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY(); // first save ever
    // Unreadable (EACCES, EIO…): never overwrite it with one user's data.
    if (forSave) {
      logger.error({ err: (err as Error).message }, 'preferences file unreadable; refusing to save over it');
      throw new CorruptPreferencesError();
    }
    logger.warn({ err: (err as Error).message }, 'preferences file unreadable; using defaults');
    return EMPTY();
  }
  // An empty file (e.g. left by a crash before writes were fsynced) holds no
  // preferences; treat it as none rather than blocking every save.
  if (text.trim() === '') return EMPTY();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (claimsAccountLayout(parsed)) {
    const l = asAccountLayout(parsed, isPrefsMap);
    if (l) return { layout: 'accounts', file: l };
  } else if (isPrefsMap(parsed)) return { layout: 'old', data: parsed };
  if (forSave) {
    logger.error('preferences file is corrupt; refusing to save over it');
    throw new CorruptPreferencesError();
  }
  logger.warn('preferences file is corrupt; using defaults');
  return EMPTY();
}

// The account's users' preferences in a loaded file (the old layout is the
// file account's only).
function usersOf(l: Loaded<AllPrefs>, account: AccountRef): AllPrefs {
  if (l.layout === 'accounts') return entryFor(l.file, account) ?? {};
  return isFileAccount(account) ? l.data : {};
}

// What's stored may come from an older version or a hand edit: keep only
// known fields whose values are still valid (a removed camera, for one).
function sanitize(accountId: string, stored: unknown): Partial<Preferences> {
  const out: Record<string, unknown> = {};
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return out;
  for (const k of Object.keys(DEFAULT_PREFERENCES)) {
    if (!Object.prototype.hasOwnProperty.call(stored, k)) continue;
    const v = (stored as Record<string, unknown>)[k];
    const r = validatePreferencesPatch(accountId, { [k]: v });
    if (r.ok) out[k] = (r.patch as Record<string, unknown>)[k];
  }
  return out as Partial<Preferences>;
}

export async function getPreferences(account: AccountRef, email: string): Promise<Preferences> {
  return { ...DEFAULT_PREFERENCES, ...sanitize(account.id, usersOf(await readAll(), account)[email.toLowerCase()]) };
}

// Atomic write: temp file with a random part, fsync, rename.
async function writeAtomic(content: string): Promise<void> {
  await fs.mkdir(dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    // Synced before the rename, so a crash right after it can't leave the
    // new name pointing at a file whose data never reached the disk.
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file());
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

// The first start in cams-admin mode (M §11.5): the old layout moves under
// the account (the file account, as the snapshot names it); a copy stays as
// .pre-accounts.bak. True if it moved.
export function moveToAccounts(account: AccountRef): Promise<boolean> {
  const run = writing.then(async () => {
    const l = await readAll(true);
    if (l.layout !== 'old') return false;
    try {
      await fs.access(file());
    } catch {
      return false; // nothing stored yet
    }
    await backupOnce(file());
    await writeAtomic(JSON.stringify(toAccounts(l.data, account), null, 2));
    logger.info('preferences_moved_to_accounts');
    return true;
  });
  writing = run.catch(() => undefined);
  return run;
}

// Writes are serialized and atomic (temp file, fsync, rename in the same
// directory), so two saves can't interleave and a crash never leaves half a
// file on the volume. During a rolling deploy the old and new pods both mount
// the volume for a few seconds, and both run as PID 1 in their containers, so
// the temp name needs a random part, not the PID.
export function savePreferences(account: AccountRef, email: string, patch: Partial<Preferences>): Promise<Preferences> {
  const run = writing.then(async () => {
    const l = await readAll(true);
    const key = email.toLowerCase();
    const users = { ...usersOf(l, account) };
    const next = { ...DEFAULT_PREFERENCES, ...sanitize(account.id, users[key]), ...patch };
    users[key] = next;
    // The layout it found; the old one only for the file account (another
    // account's entry needs the account layout: the old data moves first).
    let content: unknown;
    if (l.layout === 'old' && isFileAccount(account)) content = users;
    else {
      if (l.layout === 'old') await backupOnce(file()).catch(() => undefined);
      const base = l.layout === 'accounts' ? l.file : Object.keys(l.data).length ? toAccounts(l.data, fileAccount()) : { v: 2 as const, accounts: {} };
      content = withEntry(base, account, users);
    }
    await writeAtomic(JSON.stringify(content, null, 2));
    return next;
  });
  writing = run.catch(() => undefined);
  return run;
}

export function validatePreferencesPatch(accountId: string, body: unknown): { ok: true; patch: Partial<Preferences> } | { ok: false; details: string[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, details: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const details: string[] = [];
  // Own keys only: `in` would accept inherited names such as 'toString'.
  for (const k of Object.keys(b)) if (!Object.prototype.hasOwnProperty.call(DEFAULT_PREFERENCES, k)) details.push(`${k}: unknown field`);
  if ('defaultCamera' in b && b.defaultCamera !== null && !resolveCamera(accountId, b.defaultCamera)) details.push('defaultCamera: a configured camera id or null');
  if ('lastCamera' in b && b.lastCamera !== null && !resolveCamera(accountId, b.lastCamera)) details.push('lastCamera: a configured camera id or null');
  if ('liveQuality' in b && b.liveQuality !== 'sub' && b.liveQuality !== 'main') details.push('liveQuality: sub or main');
  let eventFilter: EventKind[] | null = null;
  if ('eventFilter' in b && !(eventFilter = eventFilterOf(b.eventFilter))) details.push('eventFilter: a list of person, vehicle, pet and motion');
  let timelineZoom: number | null = null;
  if ('timelineZoom' in b && (timelineZoom = timelineZoomOf(b.timelineZoom)) === null) details.push('timelineZoom: 24, 6, 3, 1, 0.5, 1/6 or 1/60 (hours)');
  if ('liveKeepAlive' in b && !(KEEP_ALIVE_CHOICES as readonly number[]).includes(b.liveKeepAlive as number)) details.push('liveKeepAlive: 0, 30, 60, 120, 300 or 900');
  if ('liveEvents' in b && typeof b.liveEvents !== 'boolean') details.push('liveEvents: true or false');
  if ('liveEventTypes' in b && !(Array.isArray(b.liveEventTypes) && b.liveEventTypes.every((t) => ['person', 'vehicle', 'pet', 'motion'].includes(t as string)) && new Set(b.liveEventTypes).size === b.liveEventTypes.length)) {
    details.push('liveEventTypes: a list of person, vehicle, pet and motion');
  }
  if (details.length) return { ok: false, details };
  const patch: Record<string, unknown> = { ...b };
  if (eventFilter) patch.eventFilter = eventFilter;
  if (timelineZoom !== null) patch.timelineZoom = timelineZoom;
  return { ok: true, patch: patch as Partial<Preferences> };
}
