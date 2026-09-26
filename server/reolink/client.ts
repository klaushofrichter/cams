import { randomBytes } from 'crypto';
import { IncomingMessage } from 'node:http';
import type { CameraConfig } from '../cameraRegistry';
import { logger } from '../logger';
import { CameraTarget, openRequest, readBody, ResponseTooLargeError } from './http';
import { Semaphore } from './semaphore';

export type CameraErrorCode = 'camera_offline' | 'camera_auth_failed' | 'camera_error';

// Messages are for logs only and never contain URLs, tokens or passwords;
// clients see just the code.
export class CameraError extends Error {
  constructor(
    readonly code: CameraErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

export interface CameraStatus {
  model: string;
  firmware: string;
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
  // too, but its code contains neither "ERR_TLS_" nor "CERT" - catch it (and
  // siblings like SELF_SIGNED_CERT_IN_CHAIN's signature-related relatives)
  // via "SIGNATURE" as well.
  return code.startsWith('ERR_TLS_') || code.includes('CERT') || code.includes('SIGNATURE');
}

export function classifyNetworkError(err: unknown): CameraError {
  const name = err instanceof Error ? err.name : 'Error';
  const code = (err as { code?: string }).code ?? name;
  if (isTlsCertError(code)) {
    return new CameraError('camera_error', `TLS certificate check failed (${code})`);
  }
  return new CameraError('camera_offline', `camera unreachable (${code})`);
}

export class ReolinkClient {
  private token: { value: string; expiresAt: number } | null = null;
  private loginInFlight: Promise<string> | null = null;
  private lastLoginFailure = Number.NEGATIVE_INFINITY;
  private readonly gate: Semaphore;
  private readonly timeoutMs: number;
  private readonly target: CameraTarget;

  constructor(
    private readonly cam: CameraConfig,
    private readonly opts: { timeoutMs?: number; maxConcurrent?: number; now?: () => number } = {},
  ) {
    this.gate = new Semaphore(opts.maxConcurrent ?? 2);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.target = { protocol: cam.protocol, host: cam.host, tlsServername: cam.tlsServername };
    if (cam.protocol === 'https' && !cam.tlsServername) {
      logger.warn({ cameraId: cam.id }, 'camera TLS certificate is not verified (no tlsServername configured)');
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async post(cmd: string, param: object, token?: string): Promise<ReolinkReply> {
    const path = `/cgi-bin/api.cgi?cmd=${encodeURIComponent(cmd)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const body = JSON.stringify([{ cmd, action: 0, param }]);
    return this.gate.run(async () => {
      let res: IncomingMessage;
      try {
        res = await openRequest(this.target, path, { method: 'POST', body, timeoutMs: this.timeoutMs });
      } catch (err) {
        throw classifyNetworkError(err);
      }
      if (res.statusCode === 503) {
        res.resume();
        throw new CameraError('camera_offline', `${cmd}: camera unavailable (HTTP 503)`);
      }
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
        throw classifyNetworkError(err);
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

  async command<T>(cmd: string, param: object = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken();
      const reply = await this.post(cmd, param, token);
      if (reply.code === 0) return reply.value as T;
      if (attempt === 0 && AUTH_RSP_CODES.has(reply.error?.rspCode ?? 0)) {
        this.clearTokenIfCurrent(token);
        continue;
      }
      throw new CameraError('camera_error', `${cmd} failed (rspCode ${reply.error?.rspCode ?? 'unknown'})`);
    }
    throw new CameraError('camera_auth_failed', `${cmd}: session rejected after re-login`);
  }

  async status(): Promise<CameraStatus> {
    const value = await this.command<{ DevInfo?: { model?: string; firmVer?: string } }>('GetDevInfo');
    return { model: value.DevInfo?.model ?? 'unknown', firmware: value.DevInfo?.firmVer ?? 'unknown' };
  }

  // Real firmware limits concurrent sessions and never gets a Logout when we
  // drop a token, so we only clear it when the response actually says the
  // token is bad: a 403 (FLV) or a JSON body with rspCode -6 (Snap). A
  // connection error never clears the token - the camera may just be briefly
  // unreachable - and any other unexpected response is reported as-is,
  // without spending a second login on a problem re-login can't fix.
  private async isAuthRejection(res: IncomingMessage, contentType: string): Promise<boolean> {
    if (res.statusCode === 403) {
      res.resume();
      return true;
    }
    if (res.statusCode === 200 && contentType.includes('application/json')) {
      let body: Buffer;
      try {
        body = await readBody(res, 64 * 1024);
      } catch {
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
    res.resume();
    return false;
  }

  // GET endpoints (Snap, FLV) answer an invalid token with a 403 or a JSON
  // "please login first" body instead of an rspCode on a normal reply.
  private async getWithToken(buildPath: (token: string) => string, accept: RegExp, signal?: AbortSignal): Promise<IncomingMessage> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken();
      let res: IncomingMessage;
      try {
        res = await openRequest(this.target, buildPath(encodeURIComponent(token)), { timeoutMs: this.timeoutMs, signal });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw classifyNetworkError(err);
      }
      const contentType = String(res.headers['content-type'] ?? '');
      if (res.statusCode === 200 && accept.test(contentType)) return res;
      if (res.statusCode === 503) {
        res.resume();
        throw new CameraError('camera_offline', 'camera unavailable (HTTP 503)');
      }
      if (await this.isAuthRejection(res, contentType)) {
        this.clearTokenIfCurrent(token);
        if (attempt === 0) continue;
        throw new CameraError('camera_auth_failed', 'token rejected after re-login');
      }
      throw new CameraError('camera_error', `unexpected response (HTTP ${res.statusCode})`);
    }
    throw new CameraError('camera_auth_failed', 'token rejected after re-login');
  }

  async snapshot(): Promise<Buffer> {
    // The whole request - open plus body read - stays inside the
    // concurrency gate: a snapshot download is a real load on the camera,
    // not a quick JSON round trip.
    return this.gate.run(async () => {
      const res = await this.getWithToken(
        (t) => `/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=${randomBytes(6).toString('hex')}&token=${t}`,
        /^image\/jpeg/,
      );
      try {
        return await readBody(res, 8 * 1024 * 1024);
      } catch (err) {
        if (err instanceof ResponseTooLargeError) throw new CameraError('camera_error', 'snapshot too large');
        throw classifyNetworkError(err);
      }
    });
  }

  async openLive(quality: 'sub' | 'main', signal: AbortSignal): Promise<IncomingMessage> {
    return this.getWithToken(
      (t) => `/flv?port=1935&app=bcs&stream=channel0_${quality}.bcs&token=${t}`,
      /^video\/x-flv/,
      signal,
    );
  }
}
