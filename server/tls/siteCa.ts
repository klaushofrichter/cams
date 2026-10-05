import { X509Certificate } from 'crypto';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { formatFingerprint, normalizeFingerprint } from './fingerprint';

// A cam-proxy's site CA (cam-proxy spec 2026-10-05 §10.1.4): cams pins its
// SHA-256 fingerprint, fetches the certificate from GET /tls/ca.pem (public,
// no token) and accepts it only when the fingerprint matches. The PEM itself
// is what is checked, so it is fetched without verifying the proxy's own
// certificate (which that CA signed). Errors name the proxy's host only.

export type SiteCaErrorCode = 'ca_unreachable' | 'ca_invalid' | 'ca_pin_mismatch';
export class SiteCaError extends Error {
  constructor(readonly code: SiteCaErrorCode, message: string) {
    super(message);
    this.name = 'SiteCaError';
  }
}

const MAX_PEM = 65_536;

export async function fetchPinnedCa(url: string, pins: string[], o: { timeoutMs?: number } = {}): Promise<{ pem: string; fingerprint: string }> {
  const base = new URL(url);
  const target = new URL(`${base.pathname.replace(/\/+$/, '')}/tls/ca.pem`, base);
  const dispatcher = base.protocol === 'https:' ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
  let text: string;
  try {
    const res = await undiciFetch(target, { dispatcher, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
    if (!res.ok) {
      await res.body?.cancel();
      throw new SiteCaError('ca_unreachable', `cam-proxy ${base.host} answered ${res.status} for /tls/ca.pem`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PEM) throw new SiteCaError('ca_invalid', `cam-proxy ${base.host}: /tls/ca.pem is too large`);
    text = buf.toString('utf8');
  } catch (err) {
    if (err instanceof SiteCaError) throw err;
    throw new SiteCaError('ca_unreachable', `cam-proxy ${base.host}: /tls/ca.pem unreachable (${(err as Error).name})`);
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
  const block = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text)?.[0];
  if (!block) throw new SiteCaError('ca_invalid', `cam-proxy ${base.host}: /tls/ca.pem holds no certificate`);
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(block);
  } catch {
    throw new SiteCaError('ca_invalid', `cam-proxy ${base.host}: /tls/ca.pem is not a certificate`);
  }
  const fingerprint = normalizeFingerprint(cert.fingerprint256)!;
  if (!pins.includes(fingerprint)) throw new SiteCaError('ca_pin_mismatch', `cam-proxy ${base.host}: its site CA ${formatFingerprint(fingerprint)} is not the pinned one`);
  if (!cert.ca) throw new SiteCaError('ca_invalid', `cam-proxy ${base.host}: /tls/ca.pem is not a CA certificate`);
  return { pem: `${block}\n`, fingerprint };
}

// Trusts only these CAs (never the public ones); the proxy is reached by
// address and its certificate checked against `servername`
// (proxy.<site>.internal, spec §10.3), or the URL's host without one.
export function siteCaDispatcher(pems: string[], servername?: string): Dispatcher {
  return new Agent({ connect: { ca: pems, rejectUnauthorized: true, ...(servername && { servername }) } });
}

// fetch through a dispatcher (undici's own fetch, so the two always match),
// or the global fetch without one.
export function fetchWith(dispatcher: Dispatcher | undefined): typeof fetch {
  if (!dispatcher) return fetch;
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher })) as unknown as typeof fetch;
}
