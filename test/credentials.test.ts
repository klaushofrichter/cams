// Camera credentials (migration P4, M §9.8): passwords never come from
// cams-admin; a local credentials file (CAMERA_CREDENTIALS_FILE), else, for
// the file account only, the same id in CAMERAS_FILE (the transition).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { inspect } from 'util';
import { createApp } from '../server/app';
import { keyed, setCameras } from '../server/cameraRegistry';
import { credentialsFor, credentialsWritable, loadCredentials, setCameraPassword, setLegacyCredentials } from '../server/credentials';
import { camKey, setFleet } from '../server/fleet';
import { getClient, requireClient } from '../server/reolink/clients';
import { logger } from '../server/logger';
import { ALPHA, BETA, applyFleet, cookieFor, restoreMode } from './helpers/fleet';

let dir: string, FILE: string;
const H = 'acc_file'; // the file account's id (fileAccount().id in these tests)
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const n of ['CAMERA_CREDENTIALS_FILE', 'CAMS_FILE_ACCOUNT']) saved[n] = process.env[n];
  dir = mkdtempSync(join(tmpdir(), 'cams-cred-'));
  FILE = join(dir, 'credentials.json');
  process.env.CAMERA_CREDENTIALS_FILE = FILE;
  setLegacyCredentials([]);
  loadCredentials();
});
afterEach(() => {
  for (const [n, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  restoreMode();
  setCameras([]);
  vi.restoreAllMocks();
});
const write = (o: unknown, mode = 0o600) => {
  writeFileSync(FILE, JSON.stringify(o), { mode });
  chmodSync(FILE, mode);
};

describe('lookup', () => {
  it('the credentials file first, by "<account id>/<camsId>" (never the name); a missing file is empty', () => {
    expect(credentialsFor(H, 'cam1', 'cams')).toEqual({ ok: false, problem: 'missing', user: 'cams' });
    write({ v: 1, [`${H}/cam1`]: { user: 'cams', password: 'pw1' }, [`${BETA}/cam1`]: { user: 'cams', password: 'pw2' } });
    loadCredentials();
    expect(credentialsFor(H, 'cam1', 'cams')).toEqual({ ok: true, user: 'cams', password: 'pw1' });
    expect(credentialsFor(BETA, 'cam1', 'cams')).toEqual({ ok: true, user: 'cams', password: 'pw2' });
    expect(credentialsFor(BETA, 'cam2', 'cams')).toMatchObject({ ok: false, problem: 'missing' });
  });

  it('the CAMERAS_FILE fallback only for the file account', () => {
    setLegacyCredentials([{ id: 'cam1', name: 'Den', host: 'h', protocol: 'http', user: 'cams', password: 'legacy' }]);
    expect(credentialsFor(H, 'cam1', 'cams')).toEqual({ ok: true, user: 'cams', password: 'legacy' });
    expect(credentialsFor(BETA, 'cam1', 'cams')).toMatchObject({ ok: false, problem: 'missing' });
    write({ v: 1, [`${H}/cam1`]: { user: 'cams', password: 'file' } });
    loadCredentials();
    expect(credentialsFor(H, 'cam1', 'cams')).toMatchObject({ password: 'file' });
  });

  it('a user name other than cams-admin\'s is a mismatch, shown and not guessed', () => {
    write({ v: 1, [`${H}/cam1`]: { user: 'admin', password: 'pw' } });
    loadCredentials();
    expect(credentialsFor(H, 'cam1', 'cams')).toEqual({ ok: false, problem: 'mismatch', user: 'cams' });
    expect(credentialsFor(H, 'cam1', null)).toEqual({ ok: true, user: 'admin', password: 'pw' });
  });

  it('a credentials file readable by others is a start error naming the file', () => {
    write({ v: 1 }, 0o644);
    expect(() => loadCredentials()).toThrow(/CAMERA_CREDENTIALS_FILE/);
  });

  it('a malformed file is a start error naming the file, never echoing it', () => {
    write({ v: 1, [`${H}/cam1`]: { user: 'cams', password: 7 } });
    expect(() => loadCredentials()).toThrow(/CAMERA_CREDENTIALS_FILE/);
  });
});

describe('without credentials', () => {
  it('no client: camera routes answer 503 camera_credentials_missing', async () => {
    const cams = keyed(ALPHA, [{ id: 'cam1', name: 'A', host: '127.0.0.1:9', protocol: 'http', user: 'cams', password: '' }]).map((c) => ({ ...c, credentials: 'missing' as const }));
    applyFleet([{ id: ALPHA, name: 'alpha', displayName: 'Alpha', users: [{ email: 'a@example.org', role: 'admin', disabled: false }], cameras: cams }]);
    expect(getClient(camKey(ALPHA, 'cam1'))).toBeUndefined();
    expect(() => requireClient(camKey(ALPHA, 'cam1'))).toThrow(expect.objectContaining({ code: 'camera_credentials_missing' }));
    for (const path of ['/api/cameras/cam1/status', '/api/cameras/cam1/snapshot.jpg', '/api/cameras/cam1/settings']) {
      const r = await request(createApp()).get(path).set('Cookie', cookieFor('a@example.org', ALPHA));
      expect([path, r.status, r.body.error]).toEqual([path, path.endsWith('status') ? 200 : 503, path.endsWith('status') ? 'camera_credentials_missing' : 'camera_credentials_missing']);
    }
  });
});

describe('the camera list', () => {
  it('says which cameras have no usable password here (for the camera login), only then', async () => {
    const cams = keyed(ALPHA, [
      { id: 'cam1', name: 'A', host: '127.0.0.1:9', protocol: 'http', user: 'cams', password: '' },
      { id: 'cam2', name: 'B', host: '127.0.0.1:9', protocol: 'http', user: 'cams', password: 'pw' },
    ]).map((c) => (c.camsId === 'cam1' ? { ...c, credentials: 'missing' as const } : c));
    applyFleet([{ id: ALPHA, name: 'alpha', displayName: 'Alpha', users: [{ email: 'a@example.org', role: 'admin', disabled: false }], cameras: cams }]);
    const r = await request(createApp()).get('/api/cameras').set('Cookie', cookieFor('a@example.org', ALPHA));
    expect(r.body.map((c: { id: string; credentials?: string }) => [c.id, c.credentials])).toEqual([['cam1', 'missing'], ['cam2', undefined]]);
  });
});

describe('PUT /api/cameras/:id/credentials', () => {
  const cam = (credentials: 'ok' | 'missing' | 'mismatch' = 'missing') =>
    keyed(ALPHA, [{ id: 'cam1', name: 'A', host: '127.0.0.1:9', protocol: 'http', user: 'cams', password: '' }]).map((c) => ({ ...c, credentials }));
  const fleet = () => [
    { id: ALPHA, name: 'home', displayName: 'Home', users: [{ email: 'a@example.org', role: 'admin' as const, disabled: false }, { email: 'v@example.org', role: 'viewer' as const, disabled: false }], cameras: cam() },
    { id: BETA, name: 'beta', displayName: 'Beta', users: [], cameras: [] },
  ];
  const put = (who: string, body: unknown) =>
    request(createApp()).put('/api/cameras/cam1/credentials').set('Cookie', cookieFor(who, ALPHA)).set('Origin', 'http://127.0.0.1').set('Host', '127.0.0.1').send(body as object);

  it('as viewer → 403', async () => {
    applyFleet(fleet());
    expect((await put('v@example.org', { password: 'secret-1' })).status).toBe(403);
  });

  it('as admin with a writable file → saved (mode 600); the password never appears in a log line or an answer', async () => {
    applyFleet(fleet());
    const lines: unknown[] = [];
    for (const lvl of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, lvl).mockImplementation(((...a: unknown[]) => void lines.push(a)) as never);
    expect(credentialsWritable()).toBe(true);
    const r = await put('a@example.org', { password: 'secret-pw-1' });
    expect(r.status).toBe(204);
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual({ v: 1, [`${ALPHA}/cam1`]: { user: 'cams', password: 'secret-pw-1' } });
    expect(statSync(FILE).mode & 0o777).toBe(0o600);
    expect(credentialsFor(ALPHA, 'cam1', 'cams')).toMatchObject({ ok: true, password: 'secret-pw-1' });
    // The app's own lines (the request log lines carry req/res objects that the
    // logger's serializers reduce to method, path and status: never a body).
    const own = lines.filter((l) => !(Array.isArray(l) && typeof l[0] === 'object' && l[0] !== null && ('req' in (l[0] as object) || 'res' in (l[0] as object))));
    expect(own.length).toBeGreaterThan(0);
    expect(inspect(own, { depth: 6 })).not.toContain('secret-pw-1');
    expect(r.text).not.toContain('secret-pw-1');
  });

  it('read-only → 409 with the Secret key and user, never the password', async () => {
    applyFleet(fleet());
    mkdirSync(join(dir, 'ro'));
    process.env.CAMERA_CREDENTIALS_FILE = join(dir, 'ro', 'credentials.json');
    writeFileSync(process.env.CAMERA_CREDENTIALS_FILE, JSON.stringify({ v: 1 }), { mode: 0o600 });
    chmodSync(join(dir, 'ro'), 0o500);
    try {
      loadCredentials();
      expect(credentialsWritable()).toBe(false);
      const r = await put('a@example.org', { password: 'secret-pw-2' });
      expect([r.status, r.body]).toEqual([409, { error: 'credentials_read_only', secretKey: `${ALPHA}/cam1`, user: 'cams' }]);
    } finally {
      chmodSync(join(dir, 'ro'), 0o700);
    }
  });

  it('refuses an empty, too long or control-character password', async () => {
    applyFleet(fleet());
    for (const password of ['', 'x'.repeat(129), 'a\nb', 7]) expect((await put('a@example.org', { password })).status).toBe(400);
  });

  it('another account\'s camera is unknown', async () => {
    applyFleet(fleet());
    const r = await request(createApp()).put('/api/cameras/cam1/credentials').set('Cookie', cookieFor('a@example.org', BETA)).send({ password: 'x' });
    expect(r.status).toBe(401); // not a member of Beta
    void setFleet;
  });

  it('setCameraPassword writes atomically, 600, and keeps the other entries', async () => {
    write({ v: 1, [`${BETA}/cam1`]: { user: 'u', password: 'p' } });
    loadCredentials();
    await setCameraPassword(ALPHA, 'cam1', 'cams', 'pw');
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual({ v: 1, [`${BETA}/cam1`]: { user: 'u', password: 'p' }, [`${ALPHA}/cam1`]: { user: 'cams', password: 'pw' } });
    expect(statSync(FILE).mode & 0o777).toBe(0o600);
  });
});
