import type https from 'node:https';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { normalizeFingerprint } from './fingerprint';

// The ONE file where cams opens TLS without chain validation (the one
// CodeQL js/disabling-certificate-validation exception; test/noUnverifiedTls
// keeps it that way). Three uses, each with its own check:
//  - a camera's leaf pin (cam-proxy spec 2026-10-05 §12.3): its factory
//    certificate is self-signed, so the chain can't verify; the SHA-256 of
//    the leaf is compared with the pin at secureConnect, before any request
//    byte is written, and the socket destroyed on a mismatch (Node skips
//    checkServerIdentity when the chain fails, so that hook can't do it);
//  - fetching a cam-proxy's /tls/ca.pem (§10.1.4): signed by the CA being
//    fetched; the PEM's fingerprint against the pin is the check, no token
//    is sent, nothing but the PEM is read;
//  - an https camera without tlsServername and without a pinned proxy:
//    unverified exactly as before P5 (loadCameras warns about it at start,
//    camera_tls_unverified).

const pinMismatch = () => Object.assign(new Error('camera certificate does not match its pinned fingerprint'), { code: 'ERR_TLS_CERT_PIN_MISMATCH' });

// `done(null, socket)` only when the leaf matches the pin; otherwise
// `done(err)` with the socket destroyed. Nothing is written before.
export function connectPinned(
  target: { host: string; port: number },
  fingerprint: string,
  timeoutMs: number,
  timeoutError: () => Error,
  done: (err: Error | null, socket: TLSSocket) => void,
): TLSSocket {
  const socket = tlsConnect({ host: target.host, port: target.port, rejectUnauthorized: false });
  socket.setTimeout(timeoutMs, () => socket.destroy(timeoutError()));
  const onError = (err: Error) => done(err, socket);
  socket.once('error', onError);
  socket.once('secureConnect', () => {
    socket.off('error', onError);
    socket.setTimeout(0);
    if (normalizeFingerprint(socket.getPeerCertificate().fingerprint256) === fingerprint) return done(null, socket);
    socket.destroy();
    done(pinMismatch(), socket);
  });
  return socket;
}

// Verified TLS for reading a camera's certificate (its chain and name always
// checked: this signature can't turn that off). Here so that no other file
// opens TLS sockets itself.
export function connectVerified(o: { host: string; port: number; ca?: string | Buffer | string[]; servername?: string }, onSecure: () => void): TLSSocket {
  return tlsConnect({ host: o.host, port: o.port, ...(o.ca && { ca: o.ca }), ...(o.servername && { servername: o.servername }), rejectUnauthorized: true }, onSecure);
}

// connectPinned as an http(s) request's createConnection.
export function pinnedConnection(fingerprint: string, timeoutMs: number, timeoutError: () => Error): NonNullable<https.RequestOptions['createConnection']> {
  return (opts, oncreate) => {
    const host = String(opts.hostname ?? opts.host ?? '').replace(/^\[(.*)\]$/, '$1');
    connectPinned({ host, port: Number(opts.port ?? 443) }, fingerprint, timeoutMs, timeoutError, (err, socket) => oncreate(err, socket));
    return undefined;
  };
}

// For GET /tls/ca.pem only (see above).
export const CA_FETCH_CONNECT = { rejectUnauthorized: false } as const;

// For an https camera without tlsServername and without a pinned proxy only.
export const LEGACY_UNVERIFIED_CAMERA = { rejectUnauthorized: false } as const;
