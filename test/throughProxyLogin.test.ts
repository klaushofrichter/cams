// The Camera login and Trust dialogs of a through-proxy camera (spec §6.2,
// §10.1, §10.2): relayed to the proxy with the proxy-admin token; cams stores
// nothing, logs no password, and pins only the fingerprint the proxy measured.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createApp } from '../server/app';
import { logger } from '../server/logger';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_ADMIN_TOKEN, fakeStatus } from './proxy/fakeProxy';
import { startThroughProxy, type ThroughProxy } from './helpers/throughProxy';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const SECRET = 'typed-camera-password-9';
const FP = `SHA256:${'AB'.repeat(32)}`;
const FP2 = `SHA256:${'CD'.repeat(32)}`;
let t: ThroughProxy;
let lines: unknown[][];
let credFile: string;
const credText = '{"other/cam9":{"user":"admin","password":"kept"}}';

beforeEach(async () => {
  lines = [];
  for (const lvl of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, lvl).mockImplementation(((...a: unknown[]) => void lines.push(a)) as never);
  credFile = join(mkdtempSync(join(tmpdir(), 'cams-cred-')), 'camera-credentials.json');
  writeFileSync(credFile, credText, { mode: 0o600 });
  process.env.CAMERA_CREDENTIALS_FILE = credFile;
});
afterEach(async () => {
  // As written: the request log's serializers drop `req` and `res` (server/logger.ts).
  const seen = new WeakSet();
  const written = JSON.stringify(lines, (k, v: unknown) => (k === 'req' || k === 'res' ? undefined : typeof v === 'object' && v !== null ? (seen.has(v) ? undefined : (seen.add(v), v)) : v));
  expect(written).not.toContain(SECRET);
  expect(readFileSync(credFile, 'utf8')).toBe(credText);
  expect(t.sim.loginAttempts).toBe(0);
  delete process.env.CAMERA_CREDENTIALS_FILE;
  vi.restoreAllMocks();
  await t.close();
});

const putPassword = (password: unknown = SECRET) => request(createApp()).put('/api/cameras/den/credentials').set('Cookie', auth).send({ password });
const trust = (fingerprint: unknown) => request(createApp()).post('/api/cameras/den/trust').set('Cookie', auth).send({ fingerprint });

describe('camera login relayed to the proxy', () => {
  it('saves through the proxy with the admin token, in file mode too', async () => {
    t = await startThroughProxy();
    await putPassword().expect(204);
    const r = t.fake.passwordRequests.at(-1);
    expect(r).toEqual({ cam: 'cam1', auth: `Bearer ${FAKE_ADMIN_TOKEN}`, hasPassword: true });
    expect(lines.some((l) => l[1] === 'camera_password_relayed' && (l[0] as { outcome?: string }).outcome === 'saved')).toBe(true);
  });

  it.each([
    [{ status: 422, body: { error: 'camera_refused' } }, 422, { error: 'camera_refused' }],
    [{ status: 503, body: { error: 'camera_offline' } }, 503, { error: 'camera_offline' }],
    [{ status: 409, body: { error: 'env_password', detail: 'CAMPROXY_CAMERA_PASSWORD_CAM1 sets it' } }, 409, { error: 'env_password' }],
    [{ status: 429, body: { error: 'too_many_attempts' }, retryAfter: '120' }, 429, { error: 'too_many_attempts', retryAfterS: 120 }],
    [{ status: 500, body: {} }, 502, { error: 'proxy_unavailable' }],
  ])('relays the proxy\'s %j', async (answer, status, body) => {
    t = await startThroughProxy();
    t.fake.passwordAnswer = answer;
    const r = await putPassword().expect(status);
    expect(r.body).toEqual(body);
    if (status === 429) expect(r.headers['retry-after']).toBe('120');
  });

  it('refuses a bad password here, without asking the proxy', async () => {
    t = await startThroughProxy();
    await putPassword('a\u0001b').expect(400);
    await putPassword('x'.repeat(129)).expect(400);
    expect(t.fake.passwordRequests).toEqual([]);
  });

  it('answers 403 proxy_admin_missing without an admin token, and 502 when the proxy is gone', async () => {
    t = await startThroughProxy({ adminToken: false });
    await putPassword().expect(403, { error: 'proxy_admin_missing' });
    await trust(FP).expect(403, { error: 'proxy_admin_missing' });
    expect(t.fake.passwordRequests).toEqual([]);
    await t.close();
    t = await startThroughProxy();
    t.fake.offline = true;
    await putPassword().expect(502, { error: 'proxy_unavailable' });
  });
});

describe('certificate trust relayed to the proxy', () => {
  it('pins the fingerprint the proxy measured', async () => {
    t = await startThroughProxy();
    t.fake.cameraStatus.set('cam1', fakeStatus({ online: false, tls: { mode: 'none', served: FP, problem: 'untrusted' } }));
    await trust(FP).expect(200, { mode: 'pinned' });
    expect(t.fake.trustRequests).toEqual([{ cam: 'cam1', auth: `Bearer ${FAKE_ADMIN_TOKEN}`, fingerprint: FP }]);
    expect(lines.some((l) => l[1] === 'camera_trust_relayed')).toBe(true);
  });

  it('refuses a stale fingerprint with the one served now, and sends no pin', async () => {
    t = await startThroughProxy();
    t.fake.cameraStatus.set('cam1', fakeStatus({ online: false, tls: { mode: 'none', served: FP2, problem: 'untrusted' } }));
    await trust(FP).expect(409, { error: 'fingerprint_changed', fingerprint: FP2 });
    expect(t.fake.trustRequests).toEqual([]);
  });

  it('maps the proxy\'s own fingerprint_mismatch to fingerprint_changed', async () => {
    t = await startThroughProxy();
    t.fake.cameraStatus.set('cam1', fakeStatus({ online: false, tls: { mode: 'none', served: FP, problem: 'untrusted' } }));
    t.fake.trustAnswer = { status: 409, body: { error: 'fingerprint_mismatch', detail: 'x', served: FP2 } };
    await trust(FP).expect(409, { error: 'fingerprint_changed', fingerprint: FP2 });
  });

  it('refuses a malformed fingerprint and a direct camera', async () => {
    t = await startThroughProxy({ extra: [{ id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }] });
    await trust('sha256:abc').expect(400);
    await trust(FP.toLowerCase()).expect(400);
    await request(createApp()).post('/api/cameras/shed/trust').set('Cookie', auth).send({ fingerprint: FP }).expect(404, { error: 'not_through_proxy' });
    expect(t.fake.trustRequests).toEqual([]);
  });
});
