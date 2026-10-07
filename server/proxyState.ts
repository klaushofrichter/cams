import { readFileSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { logger } from './logger';
import { fileAccount } from './fleet';
import { accountIdOf, camsIdOf, type AccountRef, type CamKey } from './fleet';
import { accountRefOf, asAccountLayout, backupOnce, claimsAccountLayout, entryFor, isFileAccount, toAccounts, withEntry, type Loaded } from './stateLayout';

// The per-camera "use cam-proxy" switch, for all users: `{ "<cameraId>": false }`
// for cameras switched off; a camera not listed uses its proxy. Kept in a
// file next to the preferences (one cams pod, so no other copy to sync):
// PROXY_STATE_FILE, else proxy-state.json in PREFS_FILE's folder (the cams-data
// volume in the cluster), else the temp folder. Either layout
// (server/stateLayout.ts): today's (the file account's) or, after the first
// cams-admin start, `{v: 2, accounts: {<id>: {name, data: {cam1: false}}}}`.
const file = () =>
  process.env.PROXY_STATE_FILE ||
  (process.env.PREFS_FILE ? join(dirname(process.env.PREFS_FILE), 'proxy-state.json') : join(tmpdir(), 'cams-proxy-state.json'));
type Off = Record<string, false>;
let state: Loaded<Off> = { layout: 'old', data: {} };
let writing: Promise<unknown> = Promise.resolve();

const offOf = (v: Record<string, unknown>): Off => Object.fromEntries(Object.entries(v).filter(([, x]) => x === false).map(([id]) => [id, false as const]));

// Read once at startup. A missing or unreadable file means every proxy is on.
export function loadProxyState(): void {
  state = { layout: 'old', data: {} };
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
    if (claimsAccountLayout(parsed)) {
      const l = asAccountLayout(parsed, (d): d is Off => typeof d === 'object' && d !== null && !Array.isArray(d));
      if (!l) throw new Error('bad account layout');
      for (const e of Object.values(l.accounts)) e.data = offOf(e.data);
      state = { layout: 'accounts', file: l };
    } else state = { layout: 'old', data: offOf(parsed as Record<string, unknown>) };
  } catch (err) {
    logger.warn({ message: (err as Error).message }, 'proxy_state_corrupt');
  }
}

function offFor(account: AccountRef): Off {
  if (state.layout === 'accounts') return entryFor(state.file, account) ?? {};
  return isFileAccount(account) ? state.data : {};
}

export function proxyEnabled(cameraId: CamKey): boolean {
  return offFor(accountRefOf(accountIdOf(cameraId)))[camsIdOf(cameraId)] !== false;
}

const sorted = (o: Off): Off => Object.fromEntries(Object.keys(o).sort().map((id) => [id, false as const]));

async function write(next: Loaded<Off>): Promise<void> {
  const target = file();
  await fs.mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next.layout === 'old' ? next.data : next.file));
  await fs.rename(tmp, target).catch(async (err: unknown) => {
    await fs.rm(tmp, { force: true });
    throw err;
  });
}

// Writes are serialized and atomic (temp file, then rename). The new value
// takes effect only once it is on disk, so a failed write changes nothing.
// The layout it found; the old one only for the file account.
export function setProxyEnabled(cameraId: CamKey, enabled: boolean): Promise<void> {
  const run = writing.then(async () => {
    const account = accountRefOf(accountIdOf(cameraId));
    const off: Off = { ...offFor(account) };
    if (enabled) delete off[camsIdOf(cameraId)];
    else off[camsIdOf(cameraId)] = false;
    let next: Loaded<Off>;
    if (state.layout === 'old' && isFileAccount(account)) next = { layout: 'old', data: sorted(off) };
    else {
      if (state.layout === 'old') await backupOnce(file()).catch(() => undefined);
      const base = state.layout === 'accounts' ? state.file : Object.keys(state.data).length ? toAccounts(state.data, fileAccount()) : { v: 2 as const, accounts: {} };
      next = { layout: 'accounts', file: withEntry(base, account, sorted(off)) };
    }
    await write(next);
    state = next;
  });
  writing = run.catch(() => undefined);
  return run;
}

// The first start in cams-admin mode: today's layout moves under the
// account (a .pre-accounts.bak copy kept). True if it moved.
export function moveProxyStateToAccounts(account: AccountRef): Promise<boolean> {
  const run = writing.then(async () => {
    loadProxyState();
    if (state.layout !== 'old') return false;
    try {
      await fs.access(file());
    } catch {
      return false;
    }
    await backupOnce(file());
    const next: Loaded<Off> = { layout: 'accounts', file: toAccounts(state.data, account) };
    await write(next);
    state = next;
    logger.info('proxy_state_moved_to_accounts');
    return true;
  });
  writing = run.catch(() => undefined);
  return run;
}
