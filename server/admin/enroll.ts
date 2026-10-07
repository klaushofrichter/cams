// Enrollment with cams-admin (contract cams-v1, M §9.1): a fresh Ed25519
// key, the one-time CAC1 code (normalised), a proof over cams's own enroll
// text, and the answer checked; the result is the key file to write.
import { createHash, generateKeyPairSync } from 'crypto';
import type { AdminKeyFile } from './keyfile';
import { enrollText, privateFromB64, publicFromB64, signText } from './sign';

const CROCKFORD = '0-9A-HJKMNP-TV-Z';
// Case-insensitive, dashes and spaces dropped, O→0, I/L→1 (as cams-admin).
export function normaliseCamsCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!s.startsWith('CAC1')) return null;
  const body = s.slice(4);
  if (!new RegExp(`^[${CROCKFORD}]{20}$`).test(body)) return null;
  return `CAC1-${body.match(/.{4}/g)!.join('-')}`;
}

export class EnrollError extends Error {
  constructor(public code: string) {
    super(`enrollment failed: ${code}`);
    this.name = 'EnrollError';
  }
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

// cams-admin's key fingerprint as the contract defines it: "SHA256:" + upper-case
// hex of the SHA-256 of the SPKI DER — computed here, never taken from the answer.
export const keyFingerprint = (spkiB64: string): string => 'SHA256:' + createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').toUpperCase();

// The enroll answer is unsigned (trust on first use): only over https, or
// plain http on this machine (tests, the local stack).
export function enrollUrlOk(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}

export async function enroll(url: string, code: string, camsVersion: string, fetchImpl: typeof fetch = fetch): Promise<AdminKeyFile> {
  if (!enrollUrlOk(url)) throw new Error('enrollment needs an https:// cams-admin URL (plain http only on localhost)');
  const canonical = normaliseCamsCode(code);
  if (!canonical) throw new EnrollError('not_a_cams_code');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const proof = signText(privateFromB64(priv), enrollText(canonical, pub));
  let res: Response;
  try {
    res = await fetchImpl(`${url.replace(/\/+$/, '')}/cams/v1/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, code: canonical, publicKey: pub, proof, camsVersion: camsVersion.slice(0, 64) }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
  } catch {
    throw new EnrollError('unreachable');
  }
  const text = (await res.text()).slice(0, 65_536);
  let b: Record<string, unknown> = {};
  try {
    b = JSON.parse(text) as Record<string, unknown>;
  } catch {
    b = {};
  }
  if (res.status !== 201) throw new EnrollError(typeof b.error === 'string' ? b.error.slice(0, 64) : `status_${res.status}`);
  if (
    b.v !== 1 || typeof b.instanceId !== 'string' || !/^cms_[0-9A-HJKMNP-TV-Z]{20}$/.test(b.instanceId) || typeof b.instanceName !== 'string' ||
    typeof b.keyId !== 'string' || !/^key_/.test(b.keyId) || !isStrings(b.accounts) || !isStrings(b.serverKeys) || !b.serverKeys.length || !isStrings(b.serverKeyFingerprints)
  ) {
    throw new Error('enrollment: unexpected answer from cams-admin');
  }
  for (const k of b.serverKeys) publicFromB64(k); // each a real Ed25519 key
  // The fingerprints the operator compares with cams-admin's page: computed from
  // the keys received; an answer whose own fingerprints disagree is refused.
  const computed = b.serverKeys.map(keyFingerprint);
  if (JSON.stringify(computed) !== JSON.stringify(b.serverKeyFingerprints)) throw new Error('enrollment: the server key fingerprints do not match its keys');
  return {
    v: 1, url: url.replace(/\/+$/, ''), instanceId: b.instanceId, instanceName: b.instanceName, keyId: b.keyId, privateKey: priv, publicKey: pub,
    serverKeys: b.serverKeys, serverKeyFingerprints: computed, accounts: b.accounts, enrolledAt: Date.now(),
  };
}
