import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createApp } from '../server/app';
import { cameraName, listCameras, setCameras, type CameraConfig } from '../server/cameraRegistry';
import { cameraNameProblem } from '../server/cameraName';
import { resetProxyClients } from '../server/proxy/client';
import { setNameGraceMs } from '../server/proxy/names';
import { startProxyStreams, stopProxyStreams } from '../server/proxy/stream';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_ADMIN_TOKEN, FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

// The camera's name (design reolink/camera-name-design.md): shown from the
// camera (through its cam-proxy, or read directly), the registry name until
// then; renamed in Settings by any signed-in user.
const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  setNameGraceMs();
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function fakeProxy(): Promise<FakeProxy> {
  const fake = await startFakeProxy();
  cleanup.push(() => fake.stop());
  return fake;
}

// den: through the fake proxy's cam1; shed: no proxy.
function cameras(fake: FakeProxy | null, o: { adminToken?: boolean; shedHost?: string } = {}): void {
  const list: CameraConfig[] = [{ id: 'shed', name: 'Shed', host: o.shedHost ?? '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }];
  if (fake) list.unshift({ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1', ...(o.adminToken !== false && { adminToken: FAKE_ADMIN_TOKEN }) } });
  setCameras(list);
  resetProxyClients();
  cleanup.push(() => setCameras([]));
}

async function serve(): Promise<string> {
  startProxyStreams({ backoffMinMs: 50, backoffMaxMs: 200, healthyMs: 200 });
  const server = http.createServer(createApp()).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  cleanup.push(() => {
    stopProxyStreams();
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// The browser's side of /api/events/stream: its frames.
function browser(base: string) {
  const frames: string[] = [];
  const req = http.get(`${base}/api/events/stream`, { headers: { Cookie: auth } }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        frames.push(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    });
  });
  req.on('error', () => undefined);
  cleanup.push(() => req.destroy());
  const named = () => frames.filter((f) => f.startsWith('event: camera\n')).map((f) => JSON.parse(f.split('data: ')[1]) as { cam: string; name: string });
  return { frames, named };
}

const shown = (id: string) => listCameras().find((c) => c.id === id)?.name;

describe('the shown name', () => {
  it("is the registry name until the proxy answers, then the proxy's", async () => {
    const fake = await fakeProxy();
    fake.cameraNames.set('cam1', 'Backyard Left');
    cameras(fake);
    expect(shown('den')).toBe('Den');
    const base = await serve();
    const b = browser(base);
    await until(() => shown('den') === 'Backyard Left');
    await until(() => b.named().length > 0);
    expect(b.named()).toEqual([{ cam: 'den', name: 'Backyard Left' }]);
    const res = await request(base).get('/api/cameras').set('Cookie', auth);
    expect(res.body.map((c: { name: string }) => c.name)).toEqual(['Backyard Left', 'Shed']);
  });

  it('follows the proxy’s `camera` message, once per change, and tells browsers', async () => {
    const fake = await fakeProxy();
    cameras(fake);
    const base = await serve();
    const b = browser(base);
    await until(() => b.frames.some((f) => f.includes('event: proxy') && f.includes('"up":true')));
    fake.push({ cam: 'cam1', type: 'camera', data: { name: 'Porch Light' } });
    await until(() => shown('den') === 'Porch Light');
    fake.push({ cam: 'cam1', type: 'camera', data: { name: 'Porch Light' } }); // no change: nothing to tell
    fake.push({ cam: 'barn', type: 'camera', data: { name: 'Elsewhere' } }); // another camera of the proxy
    await new Promise((r) => setTimeout(r, 150));
    expect(b.named()).toEqual([{ cam: 'den', name: 'Porch Light' }]);
    expect(cameraName('shed')).toBe('Shed');
  });

  // A proxy restart or a network blip must not flash the registry name in
  // every browser (review of #169): the last name stays for a grace period.
  it('keeps the name through a short outage, without telling browsers anything', async () => {
    setNameGraceMs(5000);
    const fake = await fakeProxy();
    fake.cameraNames.set('cam1', 'Backyard Left');
    cameras(fake);
    const base = await serve();
    const b = browser(base);
    await until(() => b.named().length === 1);
    const ups = () => b.frames.filter((f) => f.includes('event: proxy') && f.includes('"up":true')).length;
    const before = ups();
    fake.offline = true;
    fake.dropStreams();
    await until(() => b.frames.some((f) => f.includes('event: proxy') && f.includes('"up":false')));
    expect(shown('den')).toBe('Backyard Left');
    fake.offline = false;
    await until(() => ups() > before);
    await new Promise((r) => setTimeout(r, 150));
    expect(b.named()).toEqual([{ cam: 'den', name: 'Backyard Left' }]);
  });

  it('falls back to the registry name once after a long outage, and back once on reconnect', async () => {
    setNameGraceMs(100);
    const fake = await fakeProxy();
    fake.cameraNames.set('cam1', 'Backyard Left');
    cameras(fake);
    const base = await serve();
    const b = browser(base);
    await until(() => b.named().length === 1);
    fake.offline = true;
    fake.dropStreams();
    await until(() => shown('den') === 'Den');
    await new Promise((r) => setTimeout(r, 300));
    fake.offline = false;
    await until(() => shown('den') === 'Backyard Left', 3000);
    await new Promise((r) => setTimeout(r, 150));
    expect(b.named().map((n) => n.name)).toEqual(['Backyard Left', 'Den', 'Backyard Left']);
  });

  it('shows the registry name at once when the proxy is switched off', async () => {
    setNameGraceMs(60_000);
    const fake = await fakeProxy();
    fake.cameraNames.set('cam1', 'Backyard Left');
    cameras(fake);
    const base = await serve();
    await until(() => shown('den') === 'Backyard Left');
    const res = await request(base).put('/api/cameras/den/proxy').set('Cookie', auth).send({ enabled: false });
    cleanup.push(() => request(base).put('/api/cameras/den/proxy').set('Cookie', auth).send({ enabled: true }));
    expect(res.status).toBe(200);
    expect(shown('den')).toBe('Den');
  });

  it('asks an older proxy (no `camera` stream type) without it', async () => {
    const fake = await fakeProxy();
    fake.knownTypes = ['camera-event', 'camera-status', 'clip', 'analysis'];
    fake.cameraNames.set('cam1', 'Backyard Left');
    cameras(fake);
    const base = await serve();
    const b = browser(base);
    await until(() => b.frames.some((f) => f.includes('event: proxy') && f.includes('"up":true')));
    expect(fake.requests.filter((r) => r.path === '/api/stream').at(-1)?.query.types).toBe('camera-event,camera-status,clip,analysis');
    await until(() => shown('den') === 'Backyard Left');
  });
});

describe('PUT /api/cameras/:id/name through the proxy', () => {
  async function setup() {
    const fake = await fakeProxy();
    cameras(fake);
    const base = await serve();
    return { fake, base, put: (name: unknown, id = 'den') => request(base).put(`/api/cameras/${id}/name`).set('Cookie', auth).send({ name }) };
  }

  it('renames with the admin token and answers the name read back', async () => {
    const { fake, put, base } = await setup();
    const b = browser(base);
    const res = await put('Backyard Left');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'Backyard Left' });
    expect(fake.nameRequests).toEqual([{ cam: 'cam1', name: 'Backyard Left' }]);
    expect(fake.requests.find((r) => r.path === '/control/camera/name')?.auth).toBe(`Bearer ${FAKE_ADMIN_TOKEN}`);
    expect(shown('den')).toBe('Backyard Left');
    await until(() => b.named().length > 0);
    await new Promise((r) => setTimeout(r, 100)); // the proxy's own `camera` message changes nothing more
    expect(b.named()).toEqual([{ cam: 'den', name: 'Backyard Left' }]);
  });

  it.each([
    ['x'.repeat(32), 'Too long'],
    ['Den_Left', 'Not allowed: _'],
    [' Den', 'No space'],
    ['Den ', 'No space'],
    ['', 'Enter a name'],
    [42, 'Enter a name'],
  ])('refuses %j itself, with the reason, without asking the proxy', async (name, reason) => {
    const { fake, put } = await setup();
    const res = await put(name);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_name');
    expect(res.body.reason).toContain(reason);
    expect(fake.nameRequests).toEqual([]);
  });

  it("passes on the proxy's 400 reason", async () => {
    const { fake, put } = await setup();
    fake.nameOverride = { status: 400, body: { error: 'invalid_name', reason: 'not allowed: =' } };
    const res = await put('A=B');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_name', reason: 'not allowed: =' });
    expect(shown('den')).toBe('Den');
  });

  it('answers 503 camera_offline when the proxy says the camera is offline', async () => {
    const { fake, put } = await setup();
    fake.nameOverride = { status: 503, body: { error: 'camera_offline' } };
    const res = await put('Backyard Left');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'camera_offline' });
  });

  it("passes on the proxy's 502 camera_error (another camera failure)", async () => {
    const { fake, put } = await setup();
    fake.nameOverride = { status: 502, body: { error: 'camera_error' } };
    const res = await put('Backyard Left');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'camera_error' });
  });

  it('answers 502 when the proxy is unreachable', async () => {
    const { fake, put } = await setup();
    fake.offline = true;
    const res = await put('Backyard Left');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'proxy_unavailable' });
  });

  it('needs a signed-in user and a known camera', async () => {
    const { base, put } = await setup();
    expect((await request(base).put('/api/cameras/den/name').send({ name: 'X' })).status).toBe(401);
    expect((await put('X', 'nope')).status).toBe(404);
  });
});

// A camera without a proxy: a stand-in that speaks the camera API for the
// name commands (cam-sim gets GetDevName/SetDevName in its next release).
async function stubCamera(o: { refuse?: number; ignore?: boolean } = {}) {
  const state = { devName: { name: 'Shed', extra: 'kept' } as Record<string, unknown>, sets: [] as unknown[] };
  const app = express();
  app.use(express.json());
  app.post('/cgi-bin/api.cgi', (req, res) => {
    const [{ cmd, param }] = req.body as { cmd: string; param: Record<string, unknown> }[];
    const ok = (value: unknown) => res.json([{ cmd, code: 0, value }]);
    const fail = (rspCode: number) => res.json([{ cmd, code: 1, error: { rspCode, detail: 'refused' } }]);
    if (cmd === 'Login') return ok({ Token: { name: 'tok', leaseTime: 3600 } });
    if (cmd === 'GetDevName') return ok({ DevName: state.devName });
    if (cmd === 'GetDevInfo') return ok({ DevInfo: { model: 'RLC-1224A', firmVer: 'v3', name: state.devName.name } });
    if (cmd === 'SetDevName') {
      const d = param.DevName as Record<string, unknown>;
      state.sets.push(d);
      if (o.refuse) return fail(o.refuse);
      if (cameraNameProblem(d.name)) return fail(String(d.name).length > 31 ? -56 : -54);
      if (!o.ignore) state.devName = d;
      return ok({ rspCode: 200 });
    }
    fail(-9);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { state, host: `127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('PUT /api/cameras/:id/name on a camera without a proxy', () => {
  const put = (name: string) => request(createApp()).put('/api/cameras/shed/name').set('Cookie', auth).send({ name });

  it('writes SetDevName with the whole object, re-reads, and shows the name', async () => {
    const cam = await stubCamera();
    cameras(null, { shedHost: cam.host });
    const res = await put('Garden Shed');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'Garden Shed' });
    expect(cam.state.sets).toEqual([{ name: 'Garden Shed', extra: 'kept' }]);
    expect(shown('shed')).toBe('Garden Shed');
  });

  it('answers the name read back when the camera ignored the write', async () => {
    const cam = await stubCamera({ ignore: true });
    cameras(null, { shedHost: cam.host });
    const res = await put('Garden Shed');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'Shed' });
  });

  it.each([
    [-54, 'Not allowed'],
    [-56, 'Too long'],
  ])('turns the camera refusal %i into a 400 with the reason', async (rspCode, reason) => {
    const cam = await stubCamera({ refuse: rspCode });
    cameras(null, { shedHost: cam.host });
    const res = await put('Garden Shed');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_name');
    expect(res.body.reason).toContain(reason);
    expect(shown('shed')).toBe('Shed');
  });

  it('answers 503 camera_offline for an unreachable camera', async () => {
    cameras(null); // shed on 127.0.0.1:9
    const res = await put('Garden Shed');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'camera_offline' });
  });

  it('a camera with a proxy but no admin token is renamed directly', async () => {
    const fake = await fakeProxy();
    const cam = await stubCamera();
    setCameras([{ id: 'den', name: 'Den', host: cam.host, protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } }]);
    resetProxyClients();
    cleanup.push(() => setCameras([]));
    const res = await request(createApp()).put('/api/cameras/den/name').set('Cookie', auth).send({ name: 'Den Two' });
    expect(res.status).toBe(200);
    expect(fake.nameRequests).toEqual([]);
    expect(cam.state.sets).toHaveLength(1);
  });

  it("reads the camera's own name with its status", async () => {
    const cam = await stubCamera();
    cam.state.devName = { name: 'Garden Shed' };
    cameras(null, { shedHost: cam.host });
    expect(shown('shed')).toBe('Shed');
    const res = await request(createApp()).get('/api/cameras/shed/status').set('Cookie', auth);
    expect(res.body.online).toBe(true);
    expect(res.body.name).toBeUndefined(); // the status itself is unchanged
    expect(shown('shed')).toBe('Garden Shed');
  });
});
