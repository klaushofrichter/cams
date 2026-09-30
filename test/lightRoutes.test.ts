import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createSimCamera, SimCameraOptions, SimState } from './camera/sim';

// The camera's manual light (WhiteLed.state; measured on cam1 2026-09-29).
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
let cam: Server;
let state: SimState;

const stop = (server: Server) =>
  new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });

async function start(opts: Partial<SimCameraOptions> = {}) {
  if (cam) await stop(cam);
  const simCam = await createSimCamera({ user: 'u', password: 'p', ...opts });
  state = simCam.state;
  cam = simCam.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  resetClients();
  setCameras([{ id: 'cam1', name: 'Den', host: `127.0.0.1:${(cam.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p' }]);
}
beforeEach(() => start());
afterEach(async () => {
  await stop(cam);
  setCameras([]);
});

const get = () => request(createApp()).get('/api/cameras/cam1/light').set('Cookie', auth);
const put = (body: unknown) => request(createApp()).put('/api/cameras/cam1/light').set('Cookie', auth).send(body as object);

describe('light API', () => {
  it('reads the light as off', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ on: false });
  });

  it('switches the light on and off, writing the whole WhiteLed object', async () => {
    const before = structuredClone(state.settings.WhiteLed);
    const on = await put({ on: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ on: true });
    expect(state.settings.WhiteLed).toEqual({ ...before, state: 1 });
    expect((await get()).body).toEqual({ on: true });
    const off = await put({ on: false });
    expect(off.body).toEqual({ on: false });
    expect(state.settings.WhiteLed).toEqual(before);
  });

  it('does not write when the light is already as asked', async () => {
    const res = await put({ on: false });
    expect(res.body).toEqual({ on: false });
    expect(state.setCalls).toEqual([]);
  });

  it.each([[{}], [{ on: 'yes' }], [{ on: 1 }], [{ on: true, extra: 1 }], [[true]]])('rejects %j before calling the camera', async (body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(state.setCalls).toEqual([]);
  });

  it('reports a write the camera ignored as not applied', async () => {
    await start({ ignoreWrites: ['SetWhiteLed'] });
    const res = await put({ on: true });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'not_applied', on: false });
  });

  it('reports a refused write as a camera error', async () => {
    await start({ settingsFailures: ['SetWhiteLed'] });
    const res = await put({ on: true });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('camera_error');
  });

  it('maps an offline camera to 503 and an unknown one to 404', async () => {
    state.offline = true;
    expect((await get()).status).toBe(503);
    expect((await request(createApp()).get('/api/cameras/nope/light').set('Cookie', auth)).status).toBe(404);
  });
});
