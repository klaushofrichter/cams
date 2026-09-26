import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createMockCamera, MockCameraOptions, MockState } from './mock-camera/server';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
let cam: Server;
let state: MockState;

async function start(opts: Partial<MockCameraOptions> = {}) {
  if (cam) await new Promise<void>((r) => cam.close(() => r()));
  const mock = createMockCamera({ user: 'u', password: 'p', ...opts });
  state = mock.state;
  cam = mock.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  setCameras([{ id: 'cam1', name: 'Den', host: `127.0.0.1:${(cam.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p' }]);
  resetClients();
}
beforeEach(() => start());
afterEach(async () => {
  await new Promise<void>((r) => cam.close(() => r()));
  setCameras([]);
});

const put = (section: string, body: unknown) =>
  request(createApp()).put(`/api/cameras/cam1/settings/${section}`).set('Cookie', auth).send(body as object);

describe('settings API', () => {
  it('reads detection and image settings', async () => {
    const res = await request(createApp()).get('/api/cameras/cam1/settings').set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.body.detection).toMatchObject({ recording: true, motionRecording: 'on', motionSensitivity: 41 });
    expect(res.body.image.osd.name).toBe('Den');
  });

  it('saves detection fields, re-reads, and reports each field', async () => {
    const res = await put('detection', { motionSensitivity: 30, ai: { person: { sensitivity: 80 } } });
    expect(res.status).toBe(200);
    expect(res.body.fields).toEqual({ motionSensitivity: { ok: true }, 'ai.person.sensitivity': { ok: true } });
    expect(res.body.settings.motionSensitivity).toBe(30);
    expect(state.settings.MdAlarm.newSens.sensDef).toBe(21);
  });

  // Review focus 3.
  it('reports a partial failure per field and keeps the fields that saved', async () => {
    await start({ settingsFailures: ['SetWhiteLed'] });
    const res = await put('image', { dayNight: 'color', spotlight: { mode: 'off' }, osd: { name: 'Porch' } });
    expect(res.status).toBe(207);
    expect(res.body.fields).toEqual({ dayNight: { ok: true }, spotlight: { ok: false, error: 'camera_rejected' }, osd: { ok: true } });
    expect(res.body.settings.dayNight).toBe('color');
    expect(res.body.settings.spotlight.mode).toBe('auto');
  });

  // Review focus 1.
  it('treats an ignored write as not applied', async () => {
    await start({ ignoreWrites: ['SetIrLights'] });
    const res = await put('image', { irLights: 'off' });
    expect(res.status).toBe(207);
    expect(res.body.fields.irLights).toEqual({ ok: false, error: 'not_applied' });
  });

  // Review focus 2.
  it.each([
    ['detection', { motionSensitivity: 99 }],
    ['detection', { ai: { cat: {} } }],
    ['image', { osd: { name: 'x'.repeat(40) } }],
    ['image', { osd: { name: '門'.repeat(11) } }],
    ['image', { osd: { name: '\u200bDen' } }],
    ['image', { dayNight: 'Purple' }],
    ['image', { extra: 1 }],
  ])('rejects invalid %s input before calling the camera', async (section, body) => {
    const res = await put(section, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(state.setCalls).toEqual([]);
  });

  // Review focus 5.
  it('does not touch a custom schedule when saving other fields', async () => {
    state.settings.Rec.schedule.table.MD = '1'.repeat(84) + '0'.repeat(84);
    const res = await put('detection', { recording: false });
    expect(res.status).toBe(200);
    expect(res.body.settings.motionRecording).toBe('custom');
    expect(state.settings.Rec.schedule.table.MD).toBe('1'.repeat(84) + '0'.repeat(84));
  });

  it('reads device info with storage used and free', async () => {
    const res = await request(createApp()).get('/api/cameras/cam1/device').set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: 'RLC-1224A', storage: { totalMb: 61047, usedMb: 377, mounted: true }, certificate: null });
    expect(res.body.webUiUrl).toBe('https://127.0.0.1/');
  });

  // Review focus 4.
  it('reboots only with the exact confirmation body', async () => {
    const app = createApp();
    const post = (body: object) => request(app).post('/api/cameras/cam1/reboot').set('Cookie', auth).send(body);
    expect((await post({})).status).toBe(400);
    expect((await post({ confirm: 'yes' })).status).toBe(400);
    expect(state.reboots).toBe(0);
    const ok = await post({ confirm: 'reboot' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect(state.reboots).toBe(1);
  });

  it('reports a reboot as sent but unconfirmed when the camera drops the connection', async () => {
    await start({ rebootDropsConnection: true });
    const res = await request(createApp()).post('/api/cameras/cam1/reboot').set('Cookie', auth).send({ confirm: 'reboot' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, confirmed: false });
    expect(state.reboots).toBe(1);
  });

  it('lists cameras with a LAN web UI link built from the host without its port', async () => {
    const res = await request(createApp()).get('/api/cameras').set('Cookie', auth);
    expect(res.body).toEqual([{ id: 'cam1', name: 'Den', webUiUrl: 'https://127.0.0.1/' }]);
  });

  it('maps an offline camera to 503', async () => {
    state.offline = true;
    const res = await request(createApp()).get('/api/cameras/cam1/settings').set('Cookie', auth);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('camera_offline');
  });
});
