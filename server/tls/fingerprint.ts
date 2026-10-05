import { X509Certificate } from 'crypto';

// A SHA-256 certificate fingerprint as cams compares it: 64 lowercase hex
// digits. Accepted as typed: "SHA256:" (or "SHA-256:") and hex, with or
// without colons, any case (Node gives "AB:CD:…"; cam-proxy's Certificates
// card shows "SHA256:AB:CD:…"). Anything else (base64 included) is null.
export function normalizeFingerprint(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const hex = v.trim().replace(/^sha-?256:/i, '').replace(/:/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

// One fingerprint or a non-empty list (a CA rotation, spec 2026-10-05 §10.7).
export function fingerprintList(v: unknown): string[] | null {
  const list = Array.isArray(v) ? v : [v];
  if (!list.length) return null;
  const out = list.map(normalizeFingerprint);
  return out.every((f): f is string => f !== null) ? out : null;
}

export const formatFingerprint = (hex: string): string => `SHA256:${hex.toUpperCase().match(/../g)!.join(':')}`;

export const certFingerprint = (pem: string | Buffer): string => normalizeFingerprint(new X509Certificate(pem).fingerprint256)!;
