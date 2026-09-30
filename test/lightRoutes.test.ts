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
let sim: Awaited<ReturnType<typeof createSimCamera>>['sim'];

const stop = (server: Server) =>
  new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });

async function start(opts: Partial<SimCameraOptions> = {}) {
  if (cam) await stop(cam);
  const simCam = await createSimCamera({ user: 'u', password: 'p', ...opts });
  state = simCam.state;
  sim = simCam.sim;
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
  }, 15_000);

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

  // Measured on cam1 2026-09-30: GetWhiteLed reports the new state about 1 s
  // (on) or 3 s (off) after the switch. The released cam-sim in cams' tests
  // doesn't do that yet (cam-sim #51 does), so it's emulated here.
  function reportLate(ms: { on: number; off: number }) {
    const store = sim.engine.settings;
    const set = store.set.bind(store);
    store.set = (cmd, param, opts) => {
      const was = store.running.WhiteLed.state;
      const r = set(cmd, param, opts);
      const now = store.running.WhiteLed.state;
      if (cmd === 'SetWhiteLed' && r === null && now !== was) {
        store.running.WhiteLed.state = was;
        setTimeout(() => (store.running.WhiteLed.state = now), now === 1 ? ms.on : ms.off);
      }
      return r;
    };
  }

  it('waits for the camera to report the new state', async () => {
    reportLate({ on: 1000, off: 3000 });
    const on = await put({ on: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ on: true });
    const off = await put({ on: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ on: false });
    expect(state.setCalls).toEqual(['SetWhiteLed', 'SetWhiteLed']);
  }, 15_000);

  it('gives up after 5 s and says the switch was not applied', async () => {
    reportLate({ on: 60_000, off: 60_000 });
    const t0 = Date.now();
    const res = await put({ on: true });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'not_applied', on: false });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4500);
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 15_000);
});

