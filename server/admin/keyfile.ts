// The instance's key file (migration P4, M §9.1, §2): <data>/admin/key.json,
// written once by `admin-enroll`. It holds the instance's private key, so:
// mode 600 in a 700 folder owned by this user, written atomically, and
// refused at read when anyone else could read it (as proxy-tls.json).
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'fs';
import { randomBytes } from 'crypto';
import { dirname, join } from 'path';

export interface AdminKeyFile {
  v: 1;
  url: string;
  instanceId: string;
  instanceName: string;
  keyId: string;
  privateKey: string;
  publicKey: string;
  serverKeys: string[];
  serverKeyFingerprints: string[];
  accounts: string[];
  enrolledAt: number;
}

export const dataDir = (): string => {
  if (process.env.CAMS_DATA_DIR) return process.env.CAMS_DATA_DIR;
  if (process.env.PREFS_FILE) return dirname(process.env.PREFS_FILE);
  throw new Error('set CAMS_DATA_DIR (or PREFS_FILE) for the cams-admin files');
};

export const adminDir = (dir: string = dataDir()): string => join(dir, 'admin');

const eperm = (what: string) => Object.assign(new Error(`${what} must be mode 600 in a folder of mode 700, owned by this user; fix or delete it`), { code: 'EPERM_ADMIN_KEY' });

// Throws EPERM_ADMIN_KEY unless the file is 600 and its folder 700, both
// owned by this user. Shared by every secret file under <data>/admin/.
export function checkPrivate(file: string, code = 'EPERM_ADMIN_KEY'): void {
  const uid = process.getuid?.();
  const folder = statSync(dirname(file));
  const st = statSync(file);
  if ((st.mode & 0o077) !== 0 || (folder.mode & 0o077) !== 0 || (uid !== undefined && (st.uid !== uid || folder.uid !== uid))) {
    throw Object.assign(eperm(file.split('/').slice(-2).join('/')), { code });
  }
}

// Atomic, private: folder 700, temp file 600 with a random part, fsync, rename.
export function writePrivate(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function readKeyFile(dir: string = dataDir()): AdminKeyFile | null {
  const file = join(adminDir(dir), 'key.json');
  try {
    statSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  checkPrivate(file);
  let k: Partial<AdminKeyFile>;
  try {
    k = JSON.parse(readFileSync(file, 'utf8')) as Partial<AdminKeyFile>;
  } catch {
    throw new Error('admin/key.json is not valid JSON; enroll again (admin-enroll)');
  }
  if (
    k.v !== 1 || typeof k.url !== 'string' || typeof k.instanceId !== 'string' || !/^cms_[0-9A-HJKMNP-TV-Z]{20}$/.test(k.instanceId) ||
    typeof k.instanceName !== 'string' || typeof k.keyId !== 'string' || typeof k.privateKey !== 'string' || typeof k.publicKey !== 'string' ||
    !isStrings(k.serverKeys) || !k.serverKeys.length || !isStrings(k.serverKeyFingerprints) || !isStrings(k.accounts) || typeof k.enrolledAt !== 'number'
  ) {
    throw new Error('admin/key.json is malformed; enroll again (admin-enroll)');
  }
  return k as AdminKeyFile;
}

export function writeKeyFile(k: AdminKeyFile, dir: string = dataDir()): void {
  writePrivate(join(adminDir(dir), 'key.json'), JSON.stringify(k, null, 2));
}
