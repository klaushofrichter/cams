// Camera-changing calls of a through-proxy camera (spec §4.8, §10.1): the
// proxy-admin token cams holds per proxy, never the client token; no admin
// token, no call (403 proxy_admin_missing).
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_ADMIN_TOKEN } from './proxy/fakeProxy';
import { startThroughProxy, type ThroughProxy } from './helpers/throughProxy';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
let t: ThroughProxy;
afterEach(async () => {
  expect(t.sim.loginAttempts).toBe(0);
  await t.close();
});
const app = () => request(createApp());
const writes = () => t.fake.requests.filter((r) => /\/(settings\/|light$|reboot$|name$)/.test(r.path) && r.path !== '/api/cameras/cam1/light');

describe('settings, light, reboot and name with the proxy-admin token', () => {
  it('writes a settings section and relays the answer', async () => {
    t = await startThroughProxy();
    const r = await app().put('/api/cameras/den/settings/image').set('Cookie', auth).send({ flip: { vertical: true } }).expect(200);
    expect(r.body.settings.flip).toEqual({ vertical: true, mirror: false });
    expect(r.body.fields).toEqual({ flip: { ok: true } });
    expect(t.fake.requests.find((x) => x.path === '/api/cameras/cam1/settings/image')?.auth).toBe(`Bearer ${FAKE_ADMIN_TOKEN}`);
  });

  it('relays 207 and maps the proxy\'s 400 invalid to bad_request; 404 for another section', async () => {
    t = await startThroughProxy();
    t.fake.settingsAnswer = { status: 207, body: { fields: { flip: { ok: false, error: 'not_applied' } }, settings: { flip: { vertical: false, mirror: false } } } };
    const r = await app().put('/api/cameras/den/settings/image').set('Cookie', auth).send({ flip: { vertical: true } }).expect(207);
    expect(r.body.fields.flip).toEqual({ ok: false, error: 'not_applied' });
    t.fake.settingsAnswer = null;
    const bad = await app().put('/api/cameras/den/settings/image').set('Cookie', auth).send({ nope: 1 }).expect(400);
    expect(bad.body).toEqual({ error: 'bad_request', details: expect.any(Array) });
    await app().put('/api/cameras/den/settings/encoding').set('Cookie', auth).send({}).expect(404);
    expect(t.fake.requests.some((x) => x.path.endsWith('/settings/encoding'))).toBe(false);
  });

  it('switches the light and relays not_applied', async () => {
    t = await startThroughProxy();
    await app().put('/api/cameras/den/light').set('Cookie', auth).send({ on: true }).expect(200, { on: true });
    expect(t.fake.cameraLight.get('cam1')).toBe(true);
    await app().put('/api/cameras/den/light').set('Cookie', auth).send({ on: 'yes' }).expect(400);
    t.fake.lightIgnore = true;
    await app().put('/api/cameras/den/light').set('Cookie', auth).send({ on: false }).expect(502, { error: 'not_applied', on: true });
  });

  it('reboots through the proxy: 200, then its cooldown as reboot_cooldown', async () => {
    t = await startThroughProxy();
    await app().post('/api/cameras/den/reboot').set('Cookie', auth).send({ confirm: 'reboot' }).expect(200, { ok: true });
    await app().post('/api/cameras/den/reboot').set('Cookie', auth).send({ confirm: 'reboot' }).expect(429, { error: 'reboot_cooldown' });
    expect(t.fake.reboots).toEqual(['cam1']);
    await app().post('/api/cameras/den/reboot').set('Cookie', auth).send({}).expect(400);
    t.fake.rebootConfirmed = false;
    t.fake.rebootCooldown = false;
    await app().post('/api/cameras/den/reboot').set('Cookie', auth).send({ confirm: 'reboot' }).expect(202, { ok: true, confirmed: false });
  });

  it('renames the second camera of a two-camera proxy by its proxy id', async () => {
    t = await startThroughProxy({ cameras: [['den', 'cam1'], ['barn', 'cam2']] });
    const r = await app().put('/api/cameras/barn/name').set('Cookie', auth).send({ name: 'Big Barn' }).expect(200);
    expect(r.body).toEqual({ name: 'Big Barn' });
    expect(t.fake.nameRequests).toEqual([{ cam: 'cam2', name: 'Big Barn' }]);
    expect(t.fake.requests.some((x) => x.path === '/control/camera/name')).toBe(false);
  });

  it('answers 403 proxy_admin_missing without an admin token, and calls nothing', async () => {
    t = await startThroughProxy({ adminToken: false });
    await app().put('/api/cameras/den/settings/image').set('Cookie', auth).send({ flip: { vertical: true } }).expect(403, { error: 'proxy_admin_missing' });
    await app().put('/api/cameras/den/light').set('Cookie', auth).send({ on: true }).expect(403, { error: 'proxy_admin_missing' });
    await app().post('/api/cameras/den/reboot').set('Cookie', auth).send({ confirm: 'reboot' }).expect(403, { error: 'proxy_admin_missing' });
    await app().put('/api/cameras/den/name').set('Cookie', auth).send({ name: 'Shed' }).expect(403, { error: 'proxy_admin_missing' });
    expect(writes()).toEqual([]);
  });
});
