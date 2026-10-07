// The cams-v1 signing primitives (contract/cams-v1/README.md): the request,
// answer and enroll texts, Ed25519 sign/verify over base64 SPKI/PKCS#8 DER
// keys, and the snapshot envelope (sig over jcs(obj without sig)).
// Node crypto only. Every verify answers false on malformed input.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'crypto';
import { jcs } from './jcs';

export const sha256hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export const requestText = (method: string, pathAndQuery: string, ts: number, nonce: string, body: Buffer): string =>
  `cams-admin/v1 request\n${method.toUpperCase()}\n${pathAndQuery}\n${ts}\n${nonce}\n${sha256hex(body)}`;

export const answerText = (status: number, nonce: string, body: Buffer): string =>
  `cams-admin/v1 response\n${status}\n${nonce}\n${sha256hex(body)}`;

export const enrollText = (code: string, publicKey: string): string => `cams-admin cams-enroll v1\n${code}\n${publicKey}`;

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function publicFromB64(spkiB64: string): KeyObject {
  if (typeof spkiB64 !== 'string' || !B64.test(spkiB64)) throw new Error('public key: not base64');
  const der = Buffer.from(spkiB64, 'base64');
  if (der.length !== 44) throw new Error('public key: not a 44-byte SPKI');
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('public key: not ed25519');
  return key;
}

export function privateFromB64(pkcs8B64: string): KeyObject {
  if (typeof pkcs8B64 !== 'string' || !B64.test(pkcs8B64)) throw new Error('private key: not base64');
  const key = createPrivateKey({ key: Buffer.from(pkcs8B64, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('private key: not ed25519');
  return key;
}

export const signText = (priv: KeyObject, text: string): string => sign(null, Buffer.from(text, 'utf8'), priv).toString('base64');

export function verifyText(pub: KeyObject, text: string, sig: unknown): boolean {
  if (typeof sig !== 'string' || sig.length !== 88 || !B64.test(sig)) return false;
  const raw = Buffer.from(sig, 'base64');
  if (raw.length !== 64) return false;
  try {
    return verify(null, Buffer.from(text, 'utf8'), pub, raw);
  } catch {
    return false;
  }
}

export function verifyWithAny(keysB64: string[], text: string, sig: unknown): boolean {
  for (const k of keysB64) {
    let pub: KeyObject;
    try {
      pub = publicFromB64(k);
    } catch {
      continue;
    }
    if (verifyText(pub, text, sig)) return true;
  }
  return false;
}

export function verifySigned(keysB64: string[], obj: Record<string, unknown>): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const { sig, ...rest } = obj;
  let text: string;
  try {
    text = jcs(rest);
  } catch {
    return false;
  }
  return verifyWithAny(keysB64, text, sig);
}

export const newNonce = (): string => randomBytes(16).toString('base64url');
