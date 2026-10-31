// No direct camera call for a camera behind a proxy that takes camera calls
// (spec 2026-10-30 §6.1, plan Review Focus 1): every camera route of cams,
// and the MCP tools, with the camera's host a running cam-sim that would
// accept the configured password. With the proxy up and with it stopped,
// cam-sim sees no login, Search or Download; the camera then shows offline
// with proxy_unreachable (no fallback).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../server/app';
import { resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { seedThroughRecordings, startThroughProxy, type ThroughProxy } from './helpers/throughProxy';
import { freshTokens, issue, mcpClient, startApp, type Running } from './mcp/helpers';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const FP = `SHA256:${'AB'.repeat(32)}`;
const chicago = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
let t: ThroughProxy;
let app: Running;
let cacheDir: string;
const workerCacheDir = process.env.CACHE_DIR;
let base: { logins: number; searches: number; downloads: number; streams: number };

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cams-nodirect-'));
  process.env.CACHE_DIR = cacheDir;
  process.env.MCP_ENABLED = 'true';
  process.env.MCP_ALLOW_HTTP = 'true';
  process.env.COOKIE_SECURE = 'false';
  freshTokens();
  t = await startThroughProxy();
  resetRecordings();
  await seedThroughRecordings(t, chicago(Date.now()));
  base = { logins: t.sim.loginAttempts, searches: t.sim.searches, downloads: t.sim.downloads, streams: t.sim.streamsOpened };
  app = await startApp();
});
afterEach(async () => {
  await app.close();
  await t.close();
  for (const n of ['MCP_ENABLED', 'MCP_ALLOW_HTTP', 'COOKIE_SECURE']) delete process.env[n];
  process.env.CACHE_DIR = workerCacheDir;
  rmSync(cacheDir, { recursive: true, force: true });
});

const untouched = () => expect({ logins: t.sim.loginAttempts, searches: t.sim.searches, downloads: t.sim.downloads, streams: t.sim.streamsOpened }).toEqual(base);

// The live route: one chunk (or the refusal), then the viewer leaves.
const live = () =>
  new Promise<number>((resolve, reject) => {
    const req = http.get(`${app.url}/api/cameras/den/live?quality=sub`, { headers: { Cookie: auth } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(res.statusCode ?? 0);
      }
      res.once('data', () => {
        req.destroy();
        resolve(200);
      });
    });
    req.on('error', reject);
  });

// Every camera route cams has, with the answers it gave.
async function everyRoute(): Promise<Record<string, number>> {
  const a = request(app.url);
  const s: Record<string, number> = {};
  const go = async (name: string, r: request.Test) => void (s[name] = (await r.set('Cookie', auth)).status);
  await go('status', a.get('/api/cameras/den/status'));
  await go('device', a.get('/api/cameras/den/device'));
  await go('snapshot', a.get('/api/cameras/den/snapshot.jpg'));
  s.live = await live();
  await go('settings', a.get('/api/cameras/den/settings'));
  await go('settingsPut', a.put('/api/cameras/den/settings/image').send({ flip: { mirror: true } }));
  await go('light', a.get('/api/cameras/den/light'));
  await go('lightPut', a.put('/api/cameras/den/light').send({ on: true }));
  await go('reboot', a.post('/api/cameras/den/reboot').send({ confirm: 'reboot' }));
  await go('name', a.put('/api/cameras/den/name').send({ name: 'Den Two' }));
  await go('credentials', a.put('/api/cameras/den/credentials').send({ password: 'not-sent-to-the-camera' }));
  await go('trust', a.post('/api/cameras/den/trust').send({ fingerprint: FP }));
  const date = chicago(Date.now());
  await go('days', a.get(`/api/cameras/den/days?month=${date.slice(0, 7)}`));
  const day = await a.get(`/api/cameras/den/events?date=${date}`).set('Cookie', auth);
  s.events = day.status;
  const id = (day.body as { events?: { id: string }[] }).events?.[0]?.id ?? '20260101-000000-000010';
  await go('clip', a.get(`/api/cameras/den/clips/${id}/video`));
  await go('download', a.get(`/api/cameras/den/clips/${id}/download?quality=main`));
  await go('thumb', a.get(`/api/cameras/den/clips/${id}/thumb.jpg`));
  const at = Math.floor(Date.now() / 1000) * 1000 - 60_000;
  await go('composition', a.post('/api/cameras/den/compositions').send({ at, preS: 5, postS: 5, size: 'sd', badge: false }));
  const { token } = issue();
  const client = await mcpClient(app.url, token);
  for (const name of ['list_cameras', 'get_snapshot']) {
    const r = await client.callTool({ name, arguments: name === 'get_snapshot' ? { camera: 'den' } : {} });
    s[`mcp:${name}`] = r.isError ? 1 : 0;
  }
  await client.close();
  return s;
}

describe('a camera behind a camera-calls proxy', () => {
  it('is never called directly, with its proxy up or down', async () => {
    const up = await everyRoute();
    untouched();
    expect(up).toMatchObject({ status: 200, device: 200, snapshot: 200, live: 200, settings: 200, settingsPut: 200, light: 200, lightPut: 200, reboot: 200, name: 200, credentials: 204, events: 200, days: 200, clip: 200, download: 200 });
    await t.fake.stop();
    resetRecordings(); // nothing from the lists read while it was up
    const down = await everyRoute();
    untouched();
    const status = await request(app.url).get('/api/cameras/den/status').set('Cookie', auth);
    expect(status.body).toMatchObject({ online: false, error: 'proxy_unreachable' });
    for (const k of ['device', 'snapshot', 'live', 'settings', 'light', 'lightPut', 'reboot', 'name', 'credentials', 'trust', 'days', 'events']) expect(down[k], k).toBeGreaterThanOrEqual(500);
  }, 60_000);
});
