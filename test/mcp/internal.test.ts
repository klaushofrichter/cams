// A tool's /api call (spec §6, "Internal calls"): the in-process secret plus
// the token id give the token's principal, never a cookie's.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setCameras } from '../../server/cameraRegistry';
import { callApi, INTERNAL_HEADER, TOKEN_HEADER } from '../../server/mcp/internal';
import { getMcpTokens } from '../../server/mcp/tokens';
import { ALPHA, BETA, applyFleet, cookieFor, restoreMode, twoAccounts } from '../helpers/fleet';
import { freshTokens, issue, startApp, type Running } from './helpers';

let app: Running;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());
beforeEach(() => {
  freshTokens();
  applyFleet(twoAccounts());
});
afterEach(() => {
  restoreMode();
  setCameras([]);
});

const base = () => ({ host: '127.0.0.1', port: app.port });

describe('internal /api calls', () => {
  it('act as the token in its account, whatever cookie comes along', async () => {
    const { id } = issue(ALPHA, 'both@example.org');
    const r = await callApi(base(), id, '/api/me', { headers: { Cookie: cookieFor('both@example.org', BETA) } });
    expect(r.status).toBe(200);
    const me = (await r.json()) as { account: { id: string }; role: string; email: string };
    expect(me.account.id).toBe(ALPHA);
    expect(me.email).toBe('both@example.org');
  });

  it('take the issuer’s current role', async () => {
    const { id } = issue(BETA, 'both@example.org'); // a viewer in BETA
    const r = await callApi(base(), id, '/api/cameras/cam1/reboot', { method: 'POST' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'forbidden_role' });
  });

  it('are refused with a wrong secret, and never fall back to the cookie', async () => {
    const { id } = issue(ALPHA, 'both@example.org');
    const r = await fetch(`${app.url}/api/me`, { headers: { [INTERNAL_HEADER]: 'f'.repeat(64), [TOKEN_HEADER]: id, Cookie: cookieFor('both@example.org', ALPHA) } });
    expect(r.status).toBe(401);
  });

  it('are refused for a revoked token or an issuer no longer in the account', async () => {
    const a = issue(ALPHA, 'both@example.org');
    getMcpTokens().revoke(ALPHA, a.id, 'x');
    expect((await callApi(base(), a.id, '/api/me')).status).toBe(401);
    const b = issue(BETA, 'both@example.org');
    applyFleet(twoAccounts({ betaRemoved: 'both@example.org' }));
    expect((await callApi(base(), b.id, '/api/me')).status).toBe(401);
  });

  it('never reach the token API', async () => {
    const { id } = issue(ALPHA, 'both@example.org');
    const r = await callApi(base(), id, '/api/mcp-tokens');
    expect(r.status).toBe(403);
  });

  it('skip the per-address /api limits (the MCP limits apply instead)', async () => {
    const { id } = issue(ALPHA, 'both@example.org');
    const statuses = new Set<number>();
    for (let i = 0; i < 605; i += 25) {
      const batch = await Promise.all(Array.from({ length: 25 }, () => callApi(base(), id, '/api/me').then((r) => r.status)));
      batch.forEach((s) => statuses.add(s));
    }
    expect([...statuses]).toEqual([200]);
  }, 30_000);
});
