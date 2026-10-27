// The Settings card's API (spec §6): members issue and revoke their own MCP
// tokens; account admins also see and revoke everyone's in the account.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Writable } from 'stream';
import { createApp } from '../../server/app';
import { setCameras } from '../../server/cameraRegistry';
import { logger } from '../../server/logger';
import { ALPHA, BETA, applyFleet, cookieFor, restoreMode, twoAccounts } from '../helpers/fleet';
import { freshTokens } from './helpers';

const fleet = () => {
  const f = twoAccounts();
  f[1].users!.push({ email: 'admin@example.org', role: 'admin', disabled: false });
  return f;
};
beforeEach(() => {
  freshTokens();
  applyFleet(fleet());
  process.env.MCP_ENABLED = 'true';
});
afterEach(() => {
  restoreMode();
  setCameras([]);
  delete process.env.MCP_ENABLED;
});

const app = createApp();
const as = (email: string, acc: string) => ({
  get: (path: string) => request(app).get(path).set('Cookie', cookieFor(email, acc)),
  post: (path: string, body: object = {}) => request(app).post(path).set('Cookie', cookieFor(email, acc)).send(body),
});
const viewer = as('both@example.org', BETA); // a viewer in BETA
const admin = as('admin@example.org', BETA);

describe('/api/mcp-tokens', () => {
  it('lets a viewer issue a token for themselves, shown once', async () => {
    const r = await viewer.post('/api/mcp-tokens', { name: 'laptop', days: 7 });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^cmcp_/);
    expect(r.body.item).toMatchObject({ name: 'laptop', issuer: 'both@example.org', accountId: BETA, state: 'active' });
    expect(r.body.endpoint).toMatch(/\/mcp$/);
    const list = await viewer.get('/api/mcp-tokens');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(r.body.token);
    expect(list.body).toMatchObject({ enabled: true, plainHttp: false });
  });

  it('answers 400 for a bad name or days, and 409 for a fourth token', async () => {
    expect((await viewer.post('/api/mcp-tokens', { name: '', days: 7 })).body).toEqual({ error: 'invalid', field: 'name' });
    expect((await viewer.post('/api/mcp-tokens', { name: 'x', days: 365 })).status).toBe(400);
    for (let i = 0; i < 3; i++) expect((await viewer.post('/api/mcp-tokens', { name: `t${i}` })).status).toBe(201);
    const r = await viewer.post('/api/mcp-tokens', { name: 'four' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'too_many_tokens' });
  });

  it('shows a member only their own; an admin all with ?all=1', async () => {
    await viewer.post('/api/mcp-tokens', { name: 'mine' });
    await admin.post('/api/mcp-tokens', { name: 'admins' });
    expect((await viewer.get('/api/mcp-tokens')).body.items.map((t: { name: string }) => t.name)).toEqual(['mine']);
    expect((await viewer.get('/api/mcp-tokens?all=1')).status).toBe(403);
    const all = await admin.get('/api/mcp-tokens?all=1');
    expect(all.body.items.map((t: { issuer: string }) => t.issuer).sort()).toEqual(['admin@example.org', 'both@example.org']);
  });

  it('lets a member revoke only their own, an admin any in the account', async () => {
    const mine = (await viewer.post('/api/mcp-tokens', { name: 'mine' })).body.item.id;
    const theirs = (await admin.post('/api/mcp-tokens', { name: 'admins' })).body.item.id;
    expect((await viewer.post(`/api/mcp-tokens/${theirs}/revoke`)).status).toBe(404);
    const r = await viewer.post(`/api/mcp-tokens/${mine}/revoke`);
    expect(r.status).toBe(200);
    expect(r.body.item.state).toBe('revoked');
    const again = (await viewer.post('/api/mcp-tokens', { name: 'again' })).body.item.id;
    expect((await admin.post(`/api/mcp-tokens/${again}/revoke`)).body.item).toMatchObject({ state: 'revoked', revokedBy: 'admin@example.org' });
  });

  it('keeps accounts apart', async () => {
    const id = (await viewer.post('/api/mcp-tokens', { name: 'beta' })).body.item.id;
    const alphaAdmin = as('alpha@example.org', ALPHA);
    expect((await alphaAdmin.get('/api/mcp-tokens?all=1')).body.items).toEqual([]);
    expect((await alphaAdmin.post(`/api/mcp-tokens/${id}/revoke`)).status).toBe(404);
  });

  it('refuses a cross-origin issue', async () => {
    const r = await request(app).post('/api/mcp-tokens').set('Cookie', cookieFor('both@example.org', BETA)).set('Origin', 'https://evil.example').send({ name: 'x' });
    expect(r.status).toBe(403);
  });

  it('logs issue and revoke without the token', async () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const child = (await import('pino')).default({ level: 'info' }, sink);
    const orig = logger.info.bind(logger);
    (logger as unknown as { info: unknown }).info = child.info.bind(child);
    try {
      const r = await viewer.post('/api/mcp-tokens', { name: 'logged' });
      await viewer.post(`/api/mcp-tokens/${r.body.item.id}/revoke`);
      const text = lines.join('');
      expect(text).toContain('mcp_token_issue');
      expect(text).toContain('mcp_token_revoke');
      expect(text).not.toContain(r.body.token);
    } finally {
      (logger as unknown as { info: unknown }).info = orig;
    }
  });

  it('tells /api/me whether MCP is on', async () => {
    expect((await viewer.get('/api/me')).body.mcp).toEqual({ enabled: true, plainHttp: false });
  });
});
