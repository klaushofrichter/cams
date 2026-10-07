// The instance key file (migration P4, M §9.1): <data>/admin/key.json, mode
// 600 in a 700 folder, atomic; a file others can read is refused.
import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dataDir, readKeyFile, writeKeyFile, type AdminKeyFile } from '../../server/admin/keyfile';

const KF: AdminKeyFile = { v: 1, url: 'http://127.0.0.1:1', instanceId: 'cms_00000000000000000001', instanceName: 'cluster', keyId: 'key_00000000000000000001', privateKey: 'priv', publicKey: 'pub', serverKeys: ['s'], serverKeyFingerprints: ['SHA256:AB'], accounts: ['home'], enrolledAt: 1 };

describe('the key file', () => {
  it('writes 600 in a 700 folder, atomically, and reads back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cams-key-'));
    expect(readKeyFile(dir)).toBeNull();
    writeKeyFile(KF, dir);
    expect(statSync(join(dir, 'admin/key.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'admin')).mode & 0o777).toBe(0o700);
    expect(readKeyFile(dir)).toEqual(KF);
    expect(readdirSync(join(dir, 'admin'))).toEqual(['key.json']);
  });

  it('a key file readable by others is refused at read (EPERM_ADMIN_KEY); so is an open folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cams-key-'));
    writeKeyFile(KF, dir);
    chmodSync(join(dir, 'admin/key.json'), 0o644);
    expect(() => readKeyFile(dir)).toThrow(expect.objectContaining({ code: 'EPERM_ADMIN_KEY' }));
    chmodSync(join(dir, 'admin/key.json'), 0o600);
    chmodSync(join(dir, 'admin'), 0o755);
    expect(() => readKeyFile(dir)).toThrow(expect.objectContaining({ code: 'EPERM_ADMIN_KEY' }));
  });

  it('a malformed key file is an error naming the file, not a crash later', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cams-key-'));
    writeKeyFile({ ...KF, instanceId: 'nope' } as AdminKeyFile, dir);
    expect(() => readKeyFile(dir)).toThrow(/key\.json/);
  });

  it('dataDir: CAMS_DATA_DIR, else the preferences folder; neither → error', () => {
    const saved = { d: process.env.CAMS_DATA_DIR, p: process.env.PREFS_FILE };
    try {
      process.env.CAMS_DATA_DIR = '/data';
      expect(dataDir()).toBe('/data');
      delete process.env.CAMS_DATA_DIR;
      process.env.PREFS_FILE = '/x/y/prefs.json';
      expect(dataDir()).toBe('/x/y');
      delete process.env.PREFS_FILE;
      expect(() => dataDir()).toThrow(/CAMS_DATA_DIR/);
    } finally {
      if (saved.d === undefined) delete process.env.CAMS_DATA_DIR;
      else process.env.CAMS_DATA_DIR = saved.d;
      process.env.PREFS_FILE = saved.p;
    }
    expect(existsSync('/data/admin/key.json')).toBe(false);
  });
});
