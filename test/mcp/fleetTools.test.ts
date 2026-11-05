// The fleet tools (spec 2026-11-04-mcp-fleet-tools-design) through the SDK's
// client against the app, with the real signed client and the fake cams-admin:
// admins only, this account only, read only, and cams-admin's absence is an
// answer, not an outage.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeCache } from '../../server/admin/cache';
import { enroll } from '../../server/admin/enroll';
import { writeKeyFile } from '../../server/admin/keyfile';
import type { Snapshot } from '../../server/admin/snapshot';
import { setCameras } from '../../server/cameraRegistry';
import { pullNow, startConfig, stopConfig } from '../../server/configSource';
import { DEFAULT_FILE_ACCOUNT_ID, fileAccount, setFileAccountId } from '../../server/fleet';
import { readFleet, resetFleetAnswers } from '../../server/mcp/fleet';
import { resetMcpLimits } from '../../server/mcp/limits';
import { loadProxyState } from '../../server/proxyState';
import { signSnapshot, startFakeAdmin, type FakeAdmin } from '../admin/fakeAdmin';
import { twoAccountsSnapshot } from '../admin/snapshots';
import { camsFixtures, camsValidator } from '../helpers/contract';
import { ALPHA, BETA } from '../helpers/fleet';
import { freshTokens, issue, mcpClient, startApp, type Running } from './helpers';

const FLEET_TOOLS = ['list_proxies', 'list_viewers', 'list_moves'];
const answer = (accountId: string, marker: string) => ({
  v: 1, type: 'cams-fleet', accountId, generatedAt: 1, notRouted: 2,
  proxies: [{
    name: `${marker}-pi`, displayName: 'Pi', state: 'online', version: '2026.11.01.1', ok: false, problemCount: 1, reportedAt: 1,
    gui: { url: 'http://10.20.30.40:8480/', scope: 'private', note: 'Local network address: only reachable from inside that network.' },
    problems: [{ id: 'disk', label: 'Disk', text: '91% full', camera: null }], cameras: [{ id: 'cam1', name: 'Yard', online: true }],
    caFingerprints: ['SHA256:SMUGGLED'], tokens: [{ id: 'tok_SMUGGLED' }],
  }],
  viewers: [{
    name: `${marker}-viewer`, displayName: 'Cluster', thisViewer: true, address: null, held: [{ camera: 'cam1', fields: ['host'] }], keptOld: [],
    heldProxies: [{ proxy: 'Pi', fields: ['proxyUrl'] }], heldTotal: 2, accounts: ['acc_SMUGGLED'],
  }],
  moves: [{
    id: 'mv_0123456789ABCDEFGHJK', camera: 'cam1', cameraName: 'Yard', source: 'Pi', target: 'Spare', phase: 'copying', reason: null, bytesTotal: 1000, bytesDone: 400, rateBps: 100, etaS: 6,
    chunks: { pending: 1, copied: 0, verified: 2, skipped: 0, failed: 0, abandoned: 0 }, createdAt: 1, updatedAt: 2, endedAt: null, tokenHash: 'sha256:SMUGGLED',
  }],
  audit: ['SMUGGLED'],
});

const ENV = ['CONFIG_SOURCE', 'CAMS_DATA_DIR', 'CAMERAS_FILE', 'PROXY_STATE_FILE', 'PROXY_TLS_FILE', 'PREFS_FILE', 'CAMERA_CREDENTIALS_FILE', 'ALLOWED_EMAILS', 'MCP_ENABLED'] as const;
const saved: Record<string, string | undefined> = {};
const USERS = {
  a: [{ email: 'owner@example.org', role: 'admin', disabled: false }, { email: 'watcher@example.org', role: 'viewer', disabled: false }],
  b: [{ email: 'beta-owner@example.org', role: 'admin', disabled: false }],
};
let app: Running, fake: FakeAdmin, dir: string;

const call = async (token: string, name: string) => {
  const c = await mcpClient(app.url, token);
  try {
    return await c.callTool({ name, arguments: {} });
  } finally {
    await c.close();
  }
};
const names = async (token: string) => {
  const c = await mcpClient(app.url, token);
  try {
    return (await c.listTools()).tools.map((t) => t.name);
  } finally {
    await c.close();
  }
};
const fleetRequests = () => fake.requests.filter((r) => /\/cams\/v1\/accounts\//.test(r.path));
const applyUsers = async (users: typeof USERS, revision: string) => {
  fake.setSnapshot(twoAccountsSnapshot({ users, revision }));
  await pullNow();
};

beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

beforeEach(async () => {
  for (const n of ENV) saved[n] = process.env[n];
  freshTokens();
  resetMcpLimits();
  resetFleetAnswers();
  fake = await startFakeAdmin();
  fake.fleet = { [ALPHA]: answer(ALPHA, 'alpha'), [BETA]: answer(BETA, 'beta') };
  dir = mkdtempSync(join(tmpdir(), 'cams-mcp-fleet-'));
  Object.assign(process.env, { CONFIG_SOURCE: 'cams-admin', MCP_ENABLED: 'true', CAMS_DATA_DIR: dir, PREFS_FILE: join(dir, 'prefs.json'), PROXY_STATE_FILE: join(dir, 'ps.json'), PROXY_TLS_FILE: join(dir, 'tls.json'), CAMERA_CREDENTIALS_FILE: join(dir, 'cred.json') });
  delete process.env.CAMERAS_FILE;
  delete process.env.ALLOWED_EMAILS;
  writeFileSync(join(dir, 'cred.json'), JSON.stringify({ v: 1, [`${ALPHA}/cam1`]: { user: 'cams', password: 'pw' }, [`${BETA}/cam1`]: { user: 'cams', password: 'pw' } }), { mode: 0o600 });
  writeKeyFile(await enroll(fake.url, fake.code, 'test'), dir);
  const snap = twoAccountsSnapshot({ users: USERS });
  writeCache(signSnapshot(snap) as unknown as Snapshot, dir);
  fake.setSnapshot(snap);
  await startConfig({ pullIntervalMs: 60_000, debounceMs: 20 });
});
afterEach(async () => {
  stopConfig();
  await fake.stop();
  for (const n of ENV) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  setFileAccountId(DEFAULT_FILE_ACCOUNT_ID);
  setCameras([]);
  loadProxyState();
  resetFleetAnswers();
});

describe('who gets the fleet tools', () => {
  it('an admin token lists them; a viewer-role token neither lists nor can use them, and nothing is asked', async () => {
    expect(await names(issue(ALPHA, 'owner@example.org').token)).toEqual(expect.arrayContaining(FLEET_TOOLS));
    const { token } = issue(ALPHA, 'watcher@example.org');
    const listed = await names(token);
    expect(listed.filter((n) => FLEET_TOOLS.includes(n))).toEqual([]);
    expect(listed).toContain('list_cameras');
    for (const t of FLEET_TOOLS) {
      const r = await call(token, t);
      expect(r.isError, t).toBe(true);
      expect(JSON.stringify(r)).not.toContain('alpha-');
    }
    expect(fleetRequests()).toEqual([]);
  });

  it('a role change applies at the next call, in both directions', async () => {
    const { token } = issue(ALPHA, 'owner@example.org');
    expect((await call(token, 'list_proxies')).isError).toBeFalsy();
    await applyUsers({ ...USERS, a: [{ email: 'owner@example.org', role: 'viewer', disabled: false }] }, 'r:00000000000000d1');
    expect((await call(token, 'list_proxies')).isError).toBe(true);
    expect(await names(token)).not.toContain('list_proxies');
    await applyUsers(USERS, 'r:00000000000000d2');
    expect((await call(token, 'list_proxies')).isError).toBeFalsy();
  });

  it("a removed member's token stops working", async () => {
    const { token } = issue(ALPHA, 'owner@example.org');
    expect((await call(token, 'list_moves')).isError).toBeFalsy();
    await applyUsers({ ...USERS, a: [{ email: 'watcher@example.org', role: 'viewer', disabled: false }] }, 'r:00000000000000d3');
    await expect(mcpClient(app.url, token)).rejects.toThrow();
  });
});

describe('what each tool returns', () => {
  it('the three tools, each only its part', async () => {
    const { token } = issue(ALPHA, 'owner@example.org');
    const p = (await call(token, 'list_proxies')).structuredContent as any;
    expect(Object.keys(p).sort()).toEqual(['notRouted', 'proxies']);
    expect(p.notRouted).toBe(2);
    expect(p.proxies[0]).toEqual({
      name: 'alpha-pi', displayName: 'Pi', state: 'online', version: '2026.11.01.1', ok: false, problemCount: 1, reportedAt: 1,
      gui: { url: 'http://10.20.30.40:8480/', scope: 'private', note: 'Local network address: only reachable from inside that network.' },
      problems: [{ id: 'disk', label: 'Disk', text: '91% full', camera: null }], cameras: [{ id: 'cam1', name: 'Yard', online: true }],
    });
    const v = (await call(token, 'list_viewers')).structuredContent as any;
    expect(Object.keys(v)).toEqual(['viewers']);
    expect(v.viewers[0]).toEqual({ name: 'alpha-viewer', displayName: 'Cluster', thisViewer: true, address: null, held: [{ camera: 'cam1', fields: ['host'] }], keptOld: [], heldProxies: [{ proxy: 'Pi', fields: ['proxyUrl'] }], heldTotal: 2 });
    const m = (await call(token, 'list_moves')).structuredContent as any;
    expect(Object.keys(m)).toEqual(['moves']);
    expect(m.moves[0]).toMatchObject({ camera: 'cam1', phase: 'copying', bytesDone: 400, bytesTotal: 1000, createdAt: 1, endedAt: null });
  });

  it('asks only for the token account, whose answer is the only one seen; a field cams-admin adds never reaches the assistant', async () => {
    const { token } = issue(ALPHA, 'owner@example.org');
    for (const t of FLEET_TOOLS) {
      const r = await call(token, t);
      const raw = JSON.stringify(r);
      for (const leak of ['SMUGGLED', 'beta-', BETA, ALPHA]) expect(raw, `${t} ${leak}`).not.toContain(leak);
    }
    expect(fleetRequests().map((r) => r.path)).toEqual([`/cams/v1/accounts/${ALPHA}/fleet`]);
  });

  it('refuses an input that tries to name an account', async () => {
    const c = await mcpClient(app.url, issue(ALPHA, 'owner@example.org').token);
    try {
      const r = await c.callTool({ name: 'list_proxies', arguments: { accountId: BETA } });
      expect(r.isError).toBe(true);
    } finally {
      await c.close();
    }
    expect(fleetRequests()).toEqual([]);
  });

  it("an answer for another account isn't shown", async () => {
    fake.fleet = { [ALPHA]: answer(BETA, 'beta') };
    const r = await call(issue(ALPHA, 'owner@example.org').token, 'list_proxies');
    expect(r.structuredContent).toMatchObject({ error: 'admin_unavailable', retryable: true });
    expect(JSON.stringify(r)).not.toContain('beta-');
  });

  it("the contract's fleet fixture passes the strict schema and reads here", () => {
    const f = camsFixtures().find((x) => x.name === 'valid-fleet-response')!;
    expect(camsValidator('fleet-response', 'strict')(f.message)).toBe(true);
    expect(readFleet(f.message).proxies[0].gui?.scope).toBe('private');
  });
});

describe('when cams-admin does not answer', () => {
  it('unreachable: a retryable structured error; the other tools keep working', async () => {
    const { token } = issue(ALPHA, 'owner@example.org');
    fake.down();
    for (const t of FLEET_TOOLS) {
      const r = await call(token, t);
      expect(r.isError, t).toBe(true);
      expect(r.structuredContent, t).toEqual({ error: 'admin_unavailable', message: expect.stringMatching(/cams-admin can't be reached/), retryable: true });
    }
    const cams = await call(token, 'list_cameras');
    expect(cams.isError).toBeFalsy();
    expect((cams.structuredContent as { cameras: unknown[] }).cameras.length).toBeGreaterThan(0);
  });

  it('an unsigned, wrongly signed or unreadable answer is the same error', async () => {
    const { token } = issue(ALPHA, 'owner@example.org');
    fake.unsigned = true;
    expect((await call(token, 'list_proxies')).structuredContent).toMatchObject({ error: 'admin_unavailable' });
    fake.unsigned = false;
    fake.wrongKey = true;
    expect((await call(token, 'list_proxies')).structuredContent).toMatchObject({ error: 'admin_unavailable' });
    fake.wrongKey = false;
    fake.fleet = { [ALPHA]: { accountId: ALPHA, proxies: 'nonsense' } };
    expect((await call(token, 'list_proxies')).structuredContent).toMatchObject({ error: 'admin_unavailable' });
  });

  it('an older cams-admin: not available yet, not retryable', async () => {
    fake.fleet = null;
    const r = await call(issue(ALPHA, 'owner@example.org').token, 'list_viewers');
    expect(r.structuredContent).toEqual({ error: 'not_available', message: expect.stringMatching(/needs an update/), retryable: false });
  });

  it('cams-admin refuses (account not served, instance blocked): forbidden', async () => {
    const { token } = issue(ALPHA, 'owner@example.org');
    fake.fleet = {};
    expect((await call(token, 'list_moves')).structuredContent).toMatchObject({ error: 'forbidden', retryable: false });
    resetFleetAnswers();
    fake.revoked = true;
    expect((await call(token, 'list_moves')).structuredContent).toMatchObject({ error: 'forbidden', retryable: false });
  });

  it('without a cams-admin (file mode): not available', async () => {
    stopConfig();
    process.env.CONFIG_SOURCE = 'file';
    process.env.ALLOWED_EMAILS = 'owner@example.org';
    await startConfig({ pullIntervalMs: 60_000, debounceMs: 20 });
    const r = await call(issue(fileAccount().id, 'owner@example.org').token, 'list_proxies');
    expect(r.structuredContent).toEqual({ error: 'not_available', message: expect.stringMatching(/isn't connected to cams-admin/), retryable: false });
  });
});

describe('what cams keeps', () => {
  it('one request for calls within the short keep, a new one after it', async () => {
    const { token } = issue(ALPHA, 'owner@example.org');
    // The keep's end by hand: with a real 50 ms keep, two calls on a busy
    // machine took longer and this asked twice.
    const KEEP = 987_654;
    resetFleetAnswers(KEEP);
    let end: (() => void) | undefined;
    const realTimeout = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms !== KEEP) return realTimeout(fn, ms, ...rest);
      end = fn;
      return { unref() {} };
    }) as typeof setTimeout);
    try {
      await call(token, 'list_proxies');
      await call(token, 'list_moves');
      expect(fleetRequests()).toHaveLength(1);
      end!();
      await call(token, 'list_proxies');
      expect(fleetRequests()).toHaveLength(2);
    } finally {
      timers.mockRestore();
    }
  });

  it('an account answer is kept apart from the other account, and a failure is not kept', async () => {
    fake.fleet = {};
    const a = issue(ALPHA, 'owner@example.org').token;
    expect((await call(a, 'list_proxies')).isError).toBe(true);
    fake.fleet = { [ALPHA]: answer(ALPHA, 'alpha'), [BETA]: answer(BETA, 'beta') };
    expect((await call(a, 'list_proxies')).isError).toBeFalsy();
    const b = issue(BETA, 'beta-owner@example.org').token;
    const r = await call(b, 'list_proxies');
    expect(JSON.stringify(r)).toContain('beta-pi');
    expect(JSON.stringify(r)).not.toContain('alpha-');
  });

  it('at most 20 requests a minute: then rate_limited', async () => {
    const { token } = issue(ALPHA, 'owner@example.org');
    resetFleetAnswers(0);
    const c = await mcpClient(app.url, token);
    try {
      for (let i = 0; i < 20; i++) {
        expect((await c.callTool({ name: 'list_proxies', arguments: {} })).isError, String(i)).toBeFalsy();
        await new Promise((r) => setTimeout(r, 2));
      }
      expect((await c.callTool({ name: 'list_proxies', arguments: {} })).structuredContent).toMatchObject({ error: 'rate_limited', retryable: true });
    } finally {
      await c.close();
    }
    expect(fleetRequests()).toHaveLength(20);
  });
});

describe('read-only stays true', () => {
  it('every tool but generate_clip is annotated read-only, and the fleet tools only GET', async () => {
    const c = await mcpClient(app.url, issue(ALPHA, 'owner@example.org').token);
    try {
      const tools = (await c.listTools()).tools;
      expect(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name)).toEqual(['generate_clip']);
    } finally {
      await c.close();
    }
    const before = fake.requests.length;
    const owner = issue(ALPHA, 'owner@example.org').token;
    for (const t of FLEET_TOOLS) await call(owner, t);
    expect(fake.requests.slice(before).filter((r) => r.path.includes('/accounts/')).every((r) => r.method === 'GET')).toBe(true);
    // The client has one GET for this and the tools no other way to cams-admin.
    const src = readFileSync(join(__dirname, '../../server/mcp/tools/fleet.ts'), 'utf8') + readFileSync(join(__dirname, '../../server/mcp/fleet.ts'), 'utf8');
    expect(src).not.toMatch(/\bmethod:|registerToken|retireToken|\.report\(|\.api\(/);
  });
});
