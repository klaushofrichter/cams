// Where cams takes its accounts, users and cameras from (migration P4,
// M §9.4): CONFIG_SOURCE = file (the default: cameras.json and
// ALLOWED_EMAILS, exactly as before; also the rollback), shadow (the file,
// plus pulling cams-admin's snapshot to compare) or cams-admin (the
// verified snapshot; from the signed cache when cams-admin is unreachable,
// however old — Klaus's decision 5).
import { getAllowedEmails } from './allowedEmails';
import { appVersion } from './version';
import { loadCameras, setCameras, type FileCameraConfig } from './cameraRegistry';
import { fileAccount, setFileAccountId, setFleet } from './fleet';
import { logger } from './logger';
import { moveToAccounts } from './preferences';
import { loadProxyState, moveProxyStateToAccounts } from './proxyState';
import { loadTlsState, moveTlsPinsToAccounts } from './tls/store';
import { AdminClient } from './admin/client';
import { cacheWrittenAt, readCache, writeCache } from './admin/cache';
import { readKeyFile, type AdminKeyFile } from './admin/keyfile';
import { Puller } from './admin/puller';
import { accountParts, verifySnapshot, type AccountPart, type Snapshot } from './admin/snapshot';
import { buildFleet, type ApplyContext, type CredentialResult, type Problem } from './admin/apply';

export type ConfigMode = 'file' | 'shadow' | 'cams-admin';
const MODES: readonly ConfigMode[] = ['file', 'shadow', 'cams-admin'];

export function configMode(): ConfigMode {
  const v = process.env.CONFIG_SOURCE;
  if (v === undefined || v === '') return 'file';
  if ((MODES as readonly string[]).includes(v)) return v as ConfigMode;
  throw new Error('CONFIG_SOURCE must be file, shadow or cams-admin');
}

export interface ConfigStatus {
  mode: ConfigMode;
  appliedRevision: string | null;
  cacheVerifiedAt: number | null;
  lastPullAt: number | null;
  lastPullOkAt: number | null;
  staleSince: number | null;
  problems: Problem[];
}

const STALE_MS = 24 * 3_600_000;

interface State {
  mode: ConfigMode;
  key: AdminKeyFile | null;
  client: AdminClient | null;
  puller: Puller | null;
  applied: Snapshot | null;
  goodParts: Map<string, AccountPart>; // last good part per account (R4-16)
  legacy: FileCameraConfig[]; // CAMERAS_FILE (the transition: credentials, tokens)
  cacheVerifiedAt: number | null;
  lastGoodAt: number | null; // last successful pull, else the cache's write time
  lastPullAt: number | null;
  lastPullOkAt: number | null;
  startProblems: Problem[];
  snapProblems: Problem[];
  now: () => number;
  moved: boolean;
}
let st: State = fresh();
function fresh(): State {
  return { mode: 'file', key: null, client: null, puller: null, applied: null, goodParts: new Map(), legacy: [], cacheVerifiedAt: null, lastGoodAt: null, lastPullAt: null, lastPullOkAt: null, startProblems: [], snapProblems: [], now: Date.now, moved: false };
}

// The transition's credentials: the same id in CAMERAS_FILE, for the file
// account only (M §9.8; Task 9 adds the credentials file).
function legacyCredentials(accountName: string, camsId: string, user: string | null): CredentialResult {
  if (accountName !== fileAccount().name) return { ok: false, problem: 'missing', user };
  const c = st.legacy.find((x) => x.id === camsId);
  if (!c) return { ok: false, problem: 'missing', user };
  if (user !== null && user !== c.user) return { ok: false, problem: 'mismatch', user };
  return { ok: true, user: c.user, password: c.password };
}

// Until cams's own token is active (Task 11), a proxy uses the legacy token
// of the file account's camera with the same camsId on it (R4-12).
function legacyToken(accountId: string, camsId: string): { token: string; adminToken?: string } | undefined {
  const parts = [...st.goodParts.values()];
  const name = parts.find((p) => p.account.id === accountId)?.account.name;
  if (name !== fileAccount().name) return undefined;
  const c = st.legacy.find((x) => x.id === camsId);
  return c?.proxy ? { token: c.proxy.token, ...(c.proxy.adminToken && { adminToken: c.proxy.adminToken }) } : undefined;
}

export function applyContext(): ApplyContext {
  return {
    credentials: legacyCredentials,
    proxyToken: (accountId, _proxy, camsId) => legacyToken(accountId, camsId),
  };
}

// A verified snapshot: checked per account (a failed account keeps its last
// good part), built, and in cams-admin mode put in use.
function applySnapshot(s: Snapshot, source: 'cache' | 'pull'): void {
  const { ok, failed } = accountParts(s);
  const served = new Set(s.accounts.map((a) => a.id));
  for (const id of [...st.goodParts.keys()]) if (!served.has(id)) st.goodParts.delete(id);
  for (const p of ok) st.goodParts.set(p.account.id, p);
  st.snapProblems = failed.map((f) => ({ code: 'snapshot_invalid', accountId: f.accountId, detail: f.detail }));
  for (const f of failed) logger.warn({ accountId: f.accountId, source }, 'snapshot_invalid');
  st.applied = s;
  if (st.mode !== 'cams-admin') return;
  // The file account's id as cams-admin knows it (R4-10): stores find it by id.
  const home = s.accounts.find((a) => a.name === fileAccount().name);
  if (home && /^acc_[A-Za-z0-9]{1,40}$/.test(home.id)) setFileAccountId(home.id);
  const parts = s.accounts.map((a) => st.goodParts.get(a.id)).filter((p): p is AccountPart => !!p);
  const built = buildFleet(parts, applyContext());
  st.snapProblems.push(...built.problems);
  setFleet(built.accounts);
}

async function pullOnce(): Promise<boolean> {
  if (!st.client || !st.key) return false;
  st.lastPullAt = st.now();
  try {
    const r = await st.client.getConfig(st.applied?.revision ?? null);
    st.lastPullOkAt = st.lastGoodAt = st.now();
    if (r.status === 304) return true;
    const v = verifySnapshot(r.body, st.key.serverKeys, st.key.instanceId);
    if (!v.ok) {
      logger.warn({ reason: v.reason }, 'snapshot_refused');
      st.snapProblems = [{ code: 'snapshot_refused', detail: v.reason }];
      return true; // cams-admin answered; the configuration stays
    }
    if (v.snapshot.revision === st.applied?.revision) return true;
    applySnapshot(v.snapshot, 'pull');
    writeCache(v.snapshot);
    if (st.mode === 'cams-admin') await moveStateOnce(v.snapshot);
    logger.info({ revision: v.snapshot.revision, accounts: v.snapshot.accounts.length }, 'config_applied');
    void sendReport();
    return true;
  } catch (err) {
    logger.warn({ message: (err as Error).message }, 'config_pull_failed');
    return false;
  }
}

async function sendReport(): Promise<void> {
  if (!st.client) return;
  try {
    const r = await st.client.report({
      v: 1, mode: st.mode, version: appVersion() || 'dev', appliedRevision: st.applied?.revision ?? null, cacheVerifiedAt: st.cacheVerifiedAt,
      lastPullAt: st.lastPullAt, held: [], keptOld: [], shadow: null, tokens: { managed: 0, pending: 0, legacy: 0 },
      problems: configStatus().problems.slice(0, 50).map((p) => ({ code: p.code.slice(0, 64), ...(p.accountId && { accountId: p.accountId }), ...(p.detail && { detail: p.detail.slice(0, 200) }) })),
    });
    if (r.changed) pullSoon('report');
  } catch {
    // logged by the client; the next report goes out with the next change
  }
}

// The first cams-admin start (or the first snapshot of one that started
// without a cache): today's state files move under the file account as
// cams-admin names it (M §11.5; the .bak copies stay). Idempotent.
async function moveStateOnce(s: Snapshot): Promise<void> {
  if (st.moved) return;
  const home = s.accounts.find((a) => a.name === fileAccount().name);
  st.moved = true;
  if (!home) return;
  const ref = { id: home.id, name: home.name, displayName: home.displayName };
  await moveToAccounts(ref);
  await moveProxyStateToAccounts(ref);
  await moveTlsPinsToAccounts(ref);
  loadProxyState();
  loadTlsState();
}

export interface StartOptions { pullIntervalMs?: number; debounceMs?: number; now?: () => number }

export async function startConfig(o: StartOptions = {}): Promise<void> {
  stopConfig();
  st = fresh();
  st.now = o.now ?? Date.now;
  st.mode = configMode();
  st.legacy = loadCameras();
  if (st.mode === 'file') {
    // A verified cache names the file account's id (the rollback keeps
    // what users changed in cams-admin mode, R4-10). Nothing is pulled.
    try {
      const k = readKeyFile();
      const cache = k && readCache(k);
      // (shadow and cams-admin read it below)
      const home = cache?.accounts.find((a) => a.name === fileAccount().name);
      if (home) setFileAccountId(home.id);
    } catch (err) {
      logger.warn({ message: (err as Error).message }, 'config_cache_skipped');
    }
    setCameras(st.legacy);
    loadProxyState();
    loadTlsState();
    return;
  }
  const key = readKeyFile();
  if (!key) throw new Error(`CONFIG_SOURCE=${st.mode} needs an enrolled instance: run "node dist/server/cli.js admin-enroll --url <cams-admin>" first`);
  st.key = key;
  st.client = new AdminClient(key);
  if (st.mode === 'cams-admin' && getAllowedEmails().length) {
    st.startProblems.push({ code: 'allowed_emails_ignored' });
    logger.warn({ kind: 'config' }, 'allowed_emails_ignored');
  }
  const cache = readCache(key);
  const home = cache?.accounts.find((a) => a.name === fileAccount().name);
  if (home) setFileAccountId(home.id);
  if (cache) {
    st.cacheVerifiedAt = st.now();
    st.lastGoodAt = cacheWrittenAt();
  }
  if (st.mode === 'shadow') {
    if (cache) applySnapshot(cache, 'cache');
    setCameras(st.legacy);
    loadProxyState();
    loadTlsState();
  } else {
    if (cache) {
      applySnapshot(cache, 'cache');
      await moveStateOnce(cache);
    } else {
      setFleet([]);
      logger.warn({ kind: 'config' }, 'config_none');
    }
    loadProxyState();
    loadTlsState();
  }
  st.puller = new Puller({ pull: pullOnce, intervalMs: o.pullIntervalMs, debounceMs: o.debounceMs });
  st.puller.start();
}

export function stopConfig(): void {
  st.puller?.stop();
  st.puller = null;
}

// A pull soon (debounced): after a sign-in, a "changed" report, a confirmed change.
export function pullSoon(_reason: 'login' | 'report' | 'confirm'): void {
  st.puller?.soon();
}

// Tests: one pull now, and the wait before the next.
export const pullNow = (): Promise<void> => st.puller?.pullNow() ?? Promise.resolve();
export const nextDelayMs = (): number => st.puller?.nextDelayMs(() => 0.5) ?? 0;

export function configStatus(): ConfigStatus {
  const now = st.now();
  // From 24 h without a successful pull (or since the cache was written).
  const staleSince = st.mode !== 'file' && st.lastGoodAt !== null && now - st.lastGoodAt > STALE_MS ? st.lastGoodAt : null;
  return {
    mode: st.mode,
    appliedRevision: st.applied?.revision ?? null,
    cacheVerifiedAt: st.cacheVerifiedAt,
    lastPullAt: st.lastPullAt,
    lastPullOkAt: st.lastPullOkAt,
    staleSince,
    problems: [...st.startProblems, ...st.snapProblems],
  };
}
