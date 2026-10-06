import { randomBytes } from 'crypto';
import { IncomingMessage } from 'node:http';
import type { CameraConfig } from '../cameraRegistry';
import { logger } from '../logger';
import { TimeInfo, timeInfoFromGetTime } from '../recordings/clipNames';
import { connectPinned, connectVerified } from '../tls/leafPin';
import { type CameraTarget, type CameraTrust, openRequest, readBody, requestWasWritten, ResponseTooLargeError, splitHost, TimeoutError, trustOf } from './http';
import { Semaphore } from './semaphore';

// camera_address_unknown: a from-proxy camera whose proxy hasn't reported its
// address yet (spec 2026-10-04-camera-address-from-proxy-design).
export type CameraErrorCode = 'camera_offline' | 'camera_auth_failed' | 'camera_error' | 'camera_address_unknown';

// Messages are for logs only and never contain URLs, tokens or passwords;
// clients see just the code.
export class CameraError extends Error {
  // `requestSent`: the request reached the camera before the failure (the
  // connection dropped after it was written), so the camera may have acted.
  constructor(
    readonly code: CameraErrorCode,
    message: string,
    readonly requestSent = false,
    readonly rspCode?: number, // the camera's own refusal code (camera_error), when it sent one
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

export interface CameraStatus {
  model: string;
  firmware: string;
  simulator: string | null; // cam-sim's one extra GetDevInfo field
  name: string | null; // the camera's own name (GetDevInfo.name)
  streams: { main: StreamInfo | null; sub: StreamInfo | null };
}

export interface StreamInfo { codec: 'h264' | 'h265'; width: number; height: number; fps: number }
interface RawStream { vType?: string; width?: number; height?: number; frameRate?: number }
function toStream(s: RawStream | undefined): StreamInfo | null {
  if (!s || typeof s.width !== 'number' || typeof s.height !== 'number' || typeof s.frameRate !== 'number') return null;
  return { codec: s.vType === 'h265' ? 'h265' : 'h264', width: s.width, height: s.height, fps: s.frameRate };
}

interface ReolinkReply {
  code: number;
  value?: Record<string, unknown>;
  error?: { rspCode?: number; detail?: string };
}

const AUTH_RSP_CODES = new Set([-6]); // "please login first": token unknown or expired
const TOKEN_RENEW_MARGIN_MS = 60_000;
const LOGIN_BACKOFF_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

// TLS certificate failures (bad cert, hostname mismatch, self-signed, ...)
// are a security signal, not a reachability one: surfacing them as
// camera_offline would make an operator retry forever instead of fixing the
// certificate or tlsServername.
function isTlsCertError(code: string): boolean {
  // UNABLE_TO_VERIFY_LEAF_SIGNATURE is a certificate-verification failure
  // too, but its code contains neither "ERR_TLS_" nor "CERT" - catch it via
  // "SIGNATURE" as well. (SELF_SIGNED_CERT_IN_CHAIN and other *_CERT_*
  // codes already match the CERT check above.) A site CA's name constraint
  // refusing a leaf is one too: OpenSSL's PERMITTED_/EXCLUDED_SUBTREE_VIOLATION,
  // which Node 26 reports as UNSPECIFIED (its verify error for any code it
  // has no name for; nothing but a certificate check gives it).
  return code.startsWith('ERR_TLS_') || code.includes('CERT') || code.includes('SIGNATURE') || code.includes('SUBTREE') || code === 'UNSPECIFIED';
}

export function classifyNetworkError(err: unknown, requestSent = requestWasWritten(err)): CameraError {
  const name = err instanceof Error ? err.name : 'Error';
  const code = (err as { code?: string }).code ?? name;
  if (isTlsCertError(code)) {
    return new CameraError('camera_error', `TLS certificate check failed (${code})`);
  }
  return new CameraError('camera_offline', `camera unreachable (${code})`, requestSent);
}

const SAFE_RECORDING_NAME = /^[A-Za-z0-9_./-]+\.mp4$/;

// A 503: the camera is busy or starting, reported as offline.
function offlineOn503(res: IncomingMessage, prefix = ''): void {
  if (res.statusCode !== 503) return;
  res.resume();
  throw new CameraError('camera_offline', `${prefix}camera unavailable (HTTP 503)`);
}

export class ReolinkClient {
  private token: { value: string; expiresAt: number } | null = null;
  private time: { value: TimeInfo; at: number } | null = null;
  private loginInFlight: Promise<string> | null = null;
  private lastLoginFailure = Number.NEGATIVE_INFINITY;
  private readonly gate: Semaphore;
  // The firmware runs one Search at a time: a second concurrent Search fails
  // with rspCode -54, and the one that doesn't fail can come back empty.
  private readonly searchGate = new Semaphore(1);
  private readonly timeoutMs: number;
  private readonly target: CameraTarget;

  constructor(
    private readonly cam: CameraConfig,
    // `tlsCa` is a test seam: extra trusted CA certificates for cameraCertificate().
    // `trust`: how the camera's certificate is checked (server/tls/cameraTrust.ts);
    // without it, today's rule from tlsServername.
    private readonly opts: { timeoutMs?: number; maxConcurrent?: number; now?: () => number; tlsCa?: string | Buffer; trust?: CameraTrust } = {},
  ) {
    this.gate = new Semaphore(opts.maxConcurrent ?? 2);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.target = { protocol: cam.protocol, host: cam.host, tlsServername: cam.tlsServername, ...(opts.trust && { trust: opts.trust }) };
    if (cam.protocol === 'https' && trustOf(this.target).kind === 'none') {
      logger.warn({ cameraId: cam.id }, 'camera TLS certificate is not verified (no tlsServername configured)');
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  // A from-proxy camera before its address is known: nothing to connect to.
  private requireHost(): void {
    if (!this.cam.host) throw new CameraError('camera_address_unknown', 'waiting for the proxy to report the camera address');
  }

  private async post(cmd: string, param: object, token?: string): Promise<ReolinkReply> {
    this.requireHost();
    const path = `/cgi-bin/api.cgi?cmd=${encodeURIComponent(cmd)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const body = JSON.stringify([{ cmd, action: 0, param }]);
    return this.gate.run(async () => {
      let res: IncomingMessage;
      try {
        res = await openRequest(this.target, path, { method: 'POST', body, timeoutMs: this.timeoutMs });
      } catch (err) {
        throw classifyNetworkError(err);
      }
      offlineOn503(res, `${cmd}: `);
      if (res.statusCode !== 200) {
        res.resume();
        throw new CameraError('camera_error', `${cmd}: HTTP ${res.statusCode}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse((await readBody(res)).toString('utf8'));
      } catch (err) {
        if (err instanceof SyntaxError) throw new CameraError('camera_error', `${cmd}: response is not JSON`);
        if (err instanceof ResponseTooLargeError) throw new CameraError('camera_error', `${cmd}: response too large`);
        throw classifyNetworkError(err, true); // dropped mid-reply: the request was sent
      }
      const first = Array.isArray(parsed) ? (parsed[0] as ReolinkReply | undefined) : undefined;
      if (!first || typeof first.code !== 'number') throw new CameraError('camera_error', `${cmd}: unexpected response`);
      return first;
    });
  }

  private async login(): Promise<string> {
    const reply = await this.post('Login', {
      User: { Version: '0', userName: this.cam.user, password: this.cam.password },
    });
    const token = (reply.value?.Token ?? {}) as { name?: string; leaseTime?: number };
    if (reply.code !== 0 || !token.name) {
      this.lastLoginFailure = this.now();
      throw new CameraError('camera_auth_failed', `login rejected (rspCode ${reply.error?.rspCode ?? 'unknown'})`);
    }
    this.token = { value: token.name, expiresAt: this.now() + (token.leaseTime ?? 3600) * 1000 };
    return token.name;
  }

  // Only clear the cached token if it's still the one we used: a reply that
  // arrives after a newer token was already fetched (e.g. by a concurrent
  // request) must not wipe out that fresh token.
  private clearTokenIfCurrent(usedToken: string): void {
    if (this.token?.value === usedToken) this.token = null;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_RENEW_MARGIN_MS > this.now()) return this.token.value;
    if (this.loginInFlight) return this.loginInFlight;
    if (this.now() - this.lastLoginFailure < LOGIN_BACKOFF_MS) {
      throw new CameraError('camera_auth_failed', 'login recently rejected; backing off');
    }
    this.loginInFlight = this.login().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  // getToken() for a request: a failed login never sent the request,
  // whatever happened to the Login.
  private async requestToken(): Promise<string> {
    try {
      return await this.getToken();
    } catch (err) {
      if (err instanceof CameraError && err.requestSent) throw new CameraError(err.code, err.message);
      throw err;
    }
  }

  async command<T>(cmd: string, param: object = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.requestToken();
      const reply = await this.post(cmd, param, token);
      if (reply.code === 0) return reply.value as T;
      if (attempt === 0 && AUTH_RSP_CODES.has(reply.error?.rspCode ?? 0)) {
        this.clearTokenIfCurrent(token);
        continue;
      }
      throw new CameraError('camera_error', `${cmd} failed (rspCode ${reply.error?.rspCode ?? 'unknown'})`, false, reply.error?.rspCode);
    }
    throw new CameraError('camera_auth_failed', `${cmd}: session rejected after re-login`);
  }

  // The certificate the camera presents (subject, issuer, expiry). The camera's
  // GetCertificateInfo only says whether a custom one is installed.
  async cameraCertificate(): Promise<{ subject: string; issuer: string; validTo: string } | null> {
    if (this.cam.protocol !== 'https' || !this.cam.host) return null;
    // Same host parsing as requests (bracketed IPv6 included). This only
    // reads the certificate for display: nothing is sent, and it runs outside
    // the API gate because it opens no camera session. The certificate is
    // verified like every other request to this camera (its trust: public
    // name, site CA or leaf pin; unverified ones as before against the
    // address): an invalid or
    // expired one shows as "not available" here, and expiry is alerted on
    // separately (Grafana, cam1-cert-push).
    const { hostname, port } = splitHost(this.cam.host);
    const host = hostname.replace(/^\[(.*)\]$/, '$1');
    const trust = trustOf(this.target);
    if (trust.kind === 'unavailable') return null;
    const base = { host, port: port ?? 443 };
    const options =
      trust.kind === 'site-ca' ? { ...base, ca: trust.ca, ...(trust.servername && { servername: trust.servername }) }
      : trust.kind === 'public' ? { ...base, servername: trust.servername, ca: trust.ca ?? this.opts.tlsCa }
      : { ...base, servername: host, ca: this.opts.tlsCa }; // none: as today, verified against the address
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: { subject: string; issuer: string; validTo: string } | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(v);
      };
      const onSecure = () => {
        const c = socket.getPeerCertificate();
        const t = c?.valid_to ? Date.parse(c.valid_to) : NaN;
        // A throw here would be an uncaught exception in a socket listener.
        if (!c || Number.isNaN(t)) return finish(null);
        finish({ subject: String(c.subject?.CN ?? ''), issuer: String(c.issuer?.O ?? c.issuer?.CN ?? ''), validTo: new Date(t).toISOString() });
      };
      // A pinned camera: shown only when its certificate matches the pin.
      const socket =
        trust.kind === 'pinned'
          ? connectPinned(base, trust.fingerprint, this.timeoutMs, () => new TimeoutError(), (err) => (err ? finish(null) : onSecure()))
          : connectVerified(options, onSecure);
      // The socket's idle timeout doesn't cover a stalled handshake: an
      // explicit deadline does.
      const timer = setTimeout(() => finish(null), this.timeoutMs);
      socket.on('error', () => finish(null));
    });
  }

  async status(): Promise<CameraStatus> {
    const value = await this.command<{ DevInfo?: { model?: string; firmVer?: string; simulator?: unknown; name?: unknown } }>('GetDevInfo');
    return {
      model: value.DevInfo?.model ?? 'unknown',
      firmware: value.DevInfo?.firmVer ?? 'unknown',
      // cam-sim's one extra field (a real camera never sends it).
      simulator: typeof value.DevInfo?.simulator === 'string' ? value.DevInfo.simulator : null,
      name: typeof value.DevInfo?.name === 'string' && value.DevInfo.name ? value.DevInfo.name : null,
      streams: await this.streams(),
    };
  }

  // GetEnc changes rarely: asked once per 10 minutes; a failure only leaves
  // the streams out of the status, and is asked again after 30 s.
  private enc?: { at: number; ok: boolean; streams: { main: StreamInfo | null; sub: StreamInfo | null } };
  private async streams(): Promise<{ main: StreamInfo | null; sub: StreamInfo | null }> {
    if (this.enc && Date.now() - this.enc.at < (this.enc.ok ? 600_000 : 30_000)) return this.enc.streams;
    let ok = false;
    let streams: { main: StreamInfo | null; sub: StreamInfo | null } = { main: null, sub: null };
    try {
      const v = await this.command<{ Enc?: { mainStream?: RawStream; subStream?: RawStream } }>('GetEnc', { channel: 0 });
      streams = { main: toStream(v.Enc?.mainStream), sub: toStream(v.Enc?.subStream) };
      ok = true;
    } catch {
      // extra information: the status stands without it
    }
    this.enc = { at: Date.now(), ok, streams };
    return streams;
  }

  // Real firmware limits concurrent sessions and never gets a Logout when we
  // drop a token, so we only clear it when the response actually says the
  // token is bad: a 403, a 401 (Download answers a bad token with 401
  // text/html), or a 200 whose body is a rspCode -6 reply. Real firmware
  // (RLC-1224A v3.2.0.6011) sends that body for Snap as text/html, not
  // application/json, so the content type is deliberately ignored. A
  // connection error never clears the token here - the camera may just be
  // briefly unreachable - and any other unexpected response is reported
  // as-is, without spending a second login on a problem re-login can't fix.
  private async isAuthRejection(res: IncomingMessage): Promise<boolean> {
    if (res.statusCode === 401 || res.statusCode === 403) {
      res.resume();
      return true;
    }
    if (res.statusCode !== 200) {
      res.resume();
      return false;
    }
    let body: Buffer;
    try {
      // readBody() destroys the response itself if it exceeds the limit.
      body = await readBody(res, 64 * 1024);
    } catch {
      res.destroy();
      return false;
    }
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      const rspCode = Array.isArray(parsed) ? (parsed[0] as ReolinkReply | undefined)?.error?.rspCode : undefined;
      return rspCode === -6;
    } catch {
      return false;
    }
  }

  // Real firmware answers /flv with an invalid token by closing the
  // connection before sending any response headers (ECONNRESET / "socket
  // hang up"), exactly what a camera with a broken stream service would do.
  // Timeouts, refused or unreachable connections, aborts and TLS failures
  // are not this signal. openRequest() only rejects before the response
  // headers arrive, so any error from it qualifies on that count.
  private static isResetBeforeHeaders(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (err.name === 'AbortError' || code === 'ABORT_ERR' || isTlsCertError(code) || /TLS/.test(err.message)) return false;
    return code === 'ECONNRESET' || /socket hang up/i.test(err.message);
  }

  // After a reset /flv open: is the token still good? GetDevInfo goes
  // through command(), which clears the token on rspCode -6 and logs in once
  // (honouring the login back-off). Returns normally only if that produced a
  // different token worth one more open; otherwise it throws.
  private async revalidateAfterReset(usedToken: string): Promise<void> {
    await this.command('GetDevInfo'); // a CameraError from here is rethrown as-is
    if (!this.token || this.token.value === usedToken) {
      throw new CameraError('camera_offline', 'connection reset by camera; session is valid');
    }
  }

  // GET endpoints (Snap, FLV) don't report an invalid token with an rspCode
  // on a normal reply: Snap answers 200 with a rspCode -6 body, FLV closes
  // the connection without a response (see isResetBeforeHeaders).
  private async getWithToken(buildPath: (token: string) => string, accept: RegExp, signal?: AbortSignal): Promise<IncomingMessage> {
    this.requireHost();
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.requestToken();
      let res: IncomingMessage;
      try {
        res = await openRequest(this.target, buildPath(encodeURIComponent(token)), { timeoutMs: this.timeoutMs, signal });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt === 0 && ReolinkClient.isResetBeforeHeaders(err)) {
          await this.revalidateAfterReset(token);
          if (signal?.aborted) throw err;
          continue;
        }
        throw classifyNetworkError(err);
      }
      const contentType = String(res.headers['content-type'] ?? '');
      if (res.statusCode === 200 && accept.test(contentType)) return res;
      offlineOn503(res);
      if (await this.isAuthRejection(res)) {
        this.clearTokenIfCurrent(token);
        if (attempt === 0) continue;
        throw new CameraError('camera_auth_failed', 'token rejected after re-login');
      }
      throw new CameraError('camera_error', `unexpected response (HTTP ${res.statusCode})`);
    }
    throw new CameraError('camera_auth_failed', 'token rejected after re-login');
  }

  // One Snap attempt with an already-acquired token: open, check the
  // response and read the body, all inside the concurrency gate (a snapshot
  // download is a real load on the camera, not a quick JSON round trip).
  // getToken() must NOT be called from in here: it can call login(), which
  // itself needs a gate slot via post(), and a slot this attempt is already
  // holding can't be re-acquired - that deadlocked permanently.
  private async snapshotAttempt(token: string): Promise<{ ok: true; body: Buffer } | { ok: false }> {
    return this.gate.run(async () => {
      const path = `/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=${randomBytes(6).toString('hex')}&token=${encodeURIComponent(token)}`;
      let res: IncomingMessage;
      try {
        res = await openRequest(this.target, path, { timeoutMs: this.timeoutMs });
      } catch (err) {
        throw classifyNetworkError(err);
      }
      const contentType = String(res.headers['content-type'] ?? '');
      if (res.statusCode === 200 && /^image\/jpeg/.test(contentType)) {
        try {
          return { ok: true, body: await readBody(res, 8 * 1024 * 1024) };
        } catch (err) {
          if (err instanceof ResponseTooLargeError) throw new CameraError('camera_error', 'snapshot too large');
          throw classifyNetworkError(err);
        }
      }
      offlineOn503(res);
      if (await this.isAuthRejection(res)) return { ok: false };
      throw new CameraError('camera_error', `unexpected response (HTTP ${res.statusCode})`);
    });
  }

  async snapshot(): Promise<Buffer> {
    this.requireHost();
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.requestToken();
      const outcome = await this.snapshotAttempt(token);
      if (outcome.ok) return outcome.body;
      this.clearTokenIfCurrent(token);
      if (attempt === 0) continue;
      throw new CameraError('camera_auth_failed', 'token rejected after re-login');
    }
    throw new CameraError('camera_auth_failed', 'token rejected after re-login');
  }

  async openLive(quality: 'sub' | 'main', signal: AbortSignal): Promise<IncomingMessage> {
    return this.getWithToken(
      (t) => `/flv?port=1935&app=bcs&stream=channel0_${quality}.bcs&token=${t}`,
      /^video\/x-flv/,
      signal,
    );
  }

  // Concurrent callers share one GetTime (issue #38: a burst of proxy
  // messages asked once each until the first answer was cached).
  private timePending?: Promise<TimeInfo>;
  async timeInfo(): Promise<TimeInfo> {
    if (this.time && this.now() - this.time.at < 3600_000) return this.time.value;
    this.timePending ??= this.command<unknown>('GetTime')
      .then((raw) => {
        const value = timeInfoFromGetTime(raw);
        this.time = { value, at: this.now() };
        return value;
      })
      .finally(() => (this.timePending = undefined));
    return this.timePending;
  }

  private static dayRange(date: string) {
    const [year, mon, day] = date.split('-').map(Number);
    return {
      StartTime: { year, mon, day, hour: 0, min: 0, sec: 0 },
      EndTime: { year, mon, day, hour: 23, min: 59, sec: 59 },
    };
  }

  async searchDay(date: string, stream: 'main' | 'sub'): Promise<{ name: string; size: number }[]> {
    const value = await this.searchGate.run(() =>
      this.command<{ SearchResult?: { File?: { name: string; size: string | number }[] } }>('Search', {
        Search: { channel: 0, onlyStatus: 0, streamType: stream, ...ReolinkClient.dayRange(date) },
      }),
    );
    return (value.SearchResult?.File ?? []).map((f) => ({ name: f.name, size: Number(f.size) }));
  }

  // Days of a month (YYYY-MM) with recordings, from the camera's per-day table.
  async searchMonth(month: string): Promise<string[]> {
    const [year, mon] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    const value = await this.searchGate.run(() =>
      this.command<{ SearchResult?: { Status?: { year: number; mon: number; table: string }[] } }>('Search', {
        Search: {
          channel: 0,
          onlyStatus: 1,
          streamType: 'main',
          StartTime: { year, mon, day: 1, hour: 0, min: 0, sec: 0 },
          EndTime: { year, mon, day: lastDay, hour: 23, min: 59, sec: 59 },
        },
      }),
    );
    const days: string[] = [];
    for (const s of value.SearchResult?.Status ?? []) {
      if (s.year !== year || s.mon !== mon) continue;
      [...s.table].forEach((c, i) => {
        if (c === '1' && i < lastDay) days.push(`${month}-${String(i + 1).padStart(2, '0')}`);
      });
    }
    return days;
  }

  // A recording file as an HTTP stream. Not gated here: the recordings
  // service holds its own per-camera transfer slot for the whole transfer.
  async download(name: string, signal?: AbortSignal): Promise<IncomingMessage> {
    // Firmware: the source path must be sent as-is. A percent-encoded one
    // (%2F) makes the camera drop the connection without a response. Names
    // come from the camera's own Search, but only safe characters pass here.
    if (!SAFE_RECORDING_NAME.test(name)) throw new CameraError('camera_error', 'unexpected recording name');
    const base = name.slice(name.lastIndexOf('/') + 1);
    return this.getWithToken(
      (t) => `/cgi-bin/api.cgi?cmd=Download&source=${name}&output=${base}&token=${t}`,
      /^video\/mp4/,
      signal,
    );
  }
}
