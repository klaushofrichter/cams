// No camera passwords for cameras behind a proxy that takes camera calls
// (spec 2026-10-30 §6.2, §8): a writable credentials file loses their
// entries (on the switch and at start), a read-only one (the cluster's
// Secret) is only reported; no direct client and no camera pin for them;
// cameras.json entries with a proxy need no password.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseCameras, setCameras } from '../server/cameraRegistry';
import { loadCredentials, removeCameraPassword } from '../server/credentials';
import { CAMERA_CALLS, cleanupProxiedPasswords, loadProxyFeatures, noteProxyFeatures } from '../server/proxy/features';
import { getClient, requireClient, resetClients } from '../server/reolink/clients';
import { applyProxyTls } from '../server/tls/cameraTrust';
import { fallbackPin, loadTlsState, setFallbackPin } from '../server/tls/store';
import { fileAccount } from '../server/fleet';
import { logger } from '../server/logger';
import { k } from './helpers/fleet';

const URL_ = 'http://127.0.0.1:9/proxy';
const TOKEN = 'x'.repeat(40);
let dir: string;
let FILE: string;
let lines: [unknown, string][];
const H = () => fileAccount().id;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cams-through-clean-'));
  FILE = join(dir, 'credentials.json');
  process.env.CAMERA_CREDENTIALS_FILE = FILE;
  process.env.PROXY_FEATURES_FILE = join(dir, 'proxy-features.json');
  process.env.PROXY_TLS_FILE = join(dir, 'proxy-tls.json');
  loadProxyFeatures();
  loadTlsState();
  lines = [];
  for (const lvl of ['info', 'warn'] as const) vi.spyOn(logger, lvl).mockImplementation(((o: unknown, m: string) => void lines.push([o, m])) as never);
  setCameras([
    { id: 'den', name: 'Den', host: '192.0.2.5', protocol: 'https', user: 'admin', password: 'pw', proxy: { url: URL_, token: TOKEN, camera: 'cam1' } },
    { id: 'shed', name: 'Shed', host: '192.0.2.6', protocol: 'http', user: 'admin', password: 'pw2' },
  ]);
  resetClients();
});
afterEach(() => {
  vi.restoreAllMocks();
  setCameras([]);
  for (const n of ['CAMERA_CREDENTIALS_FILE', 'PROXY_FEATURES_FILE', 'PROXY_TLS_FILE']) delete process.env[n];
  loadProxyFeatures();
  loadTlsState();
});

const writeCreds = (mode = 0o600) => {
  writeFileSync(FILE, JSON.stringify({ v: 1, [`${H()}/den`]: { user: 'admin', password: 'pw' }, [`${H()}/shed`]: { user: 'admin', password: 'pw2' } }), { mode });
  chmodSync(FILE, mode);
  loadCredentials();
};
const through = () => noteProxyFeatures(H(), URL_, [{ features: [CAMERA_CALLS] }]);

describe('removeCameraPassword', () => {
  it('removes one entry, keeps the others and mode 600', async () => {
    writeCreds();
    expect(await removeCameraPassword(H(), 'den')).toBe(true);
    const saved = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual([`${H()}/shed`, 'v']);
    expect(statSync(FILE).mode & 0o777).toBe(0o600);
    expect(await removeCameraPassword(H(), 'den')).toBe(false);
  });
});

describe('the cleanup for through-proxy cameras', () => {
  it('runs when the proxy starts taking camera calls', async () => {
    writeCreds();
    await through();
    await vi.waitFor(() => expect(Object.keys(JSON.parse(readFileSync(FILE, 'utf8')) as object)).not.toContain(`${H()}/den`));
    expect(lines.some(([o, m]) => m === 'camera_password_removed' && (o as { cameraId: string }).cameraId === k('den'))).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(FILE, 'utf8')) as object)).toContain(`${H()}/shed`);
  });

  it('runs at start for every through-proxy camera with an entry', async () => {
    await through();
    writeCreds();
    await cleanupProxiedPasswords();
    expect(Object.keys(JSON.parse(readFileSync(FILE, 'utf8')) as object)).toEqual(['v', `${H()}/shed`]);
  });

  it('only reports a read-only file, once', async () => {
    writeCreds();
    chmodSync(dir, 0o500);
    try {
      await through();
      await cleanupProxiedPasswords();
      await cleanupProxiedPasswords();
      const left = lines.filter(([, m]) => m === 'camera_password_left');
      expect(left).toEqual([[{ cameraId: k('den'), reason: 'read_only' }, 'camera_password_left']]);
      expect(Object.keys(JSON.parse(readFileSync(FILE, 'utf8')) as object)).toContain(`${H()}/den`);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('no direct call and no camera pin for a through-proxy camera', () => {
  it('refuses a direct client, logged once', async () => {
    await through();
    expect(getClient(k('den'))).toBeUndefined();
    expect(() => requireClient(k('den'))).toThrow(expect.objectContaining({ code: 'camera_offline' }));
    expect(() => requireClient(k('den'))).toThrow();
    expect(lines.filter(([, m]) => m === 'direct_call_refused')).toHaveLength(1);
    expect(getClient(k('shed'))).toBeDefined();
  });

  it('clears the fallback pin instead of setting one', async () => {
    setCameras([{ id: 'den', name: 'Den', host: '192.0.2.5', protocol: 'https', user: 'admin', password: 'pw', proxy: { url: 'http://127.0.0.1:9/proxy', token: TOKEN, camera: 'cam1', caFingerprint: ['a'.repeat(64)] } }]);
    await setFallbackPin(k('den'), { fingerprint: 'b'.repeat(64), host: '192.0.2.5' });
    await through();
    await applyProxyTls(k('den'), { mode: 'pinned', fingerprint: 'c'.repeat(64) });
    expect(fallbackPin(k('den'), '192.0.2.5')).toBeUndefined();
  });
});

describe('cameras.json', () => {
  it('takes an entry with a proxy and no password', () => {
    const list = parseCameras([{ id: 'den', name: 'Den', host: '192.0.2.5', user: 'admin', proxy: { url: URL_, token: TOKEN } }], 'cameras.json');
    expect(list[0].password).toBe('');
    expect(() => parseCameras([{ id: 'den', name: 'Den', host: '192.0.2.5', user: 'admin' }], 'cameras.json')).toThrow(/password/);
  });
});
