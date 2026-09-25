import { randomBytes } from 'crypto';
import { IncomingMessage } from 'node:http';
import type { CameraConfig } from '../cameraRegistry';
import { logger } from '../logger';
import { CameraTarget, openRequest, readBody } from './http';
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

function offline(err: unknown): CameraError {
  const name = err instanceof Error ? err.name : 'Error';
  const code = (err as { code?: string }).code;
  return new CameraError('camera_offline', `camera unreachable (${code ?? name})`);
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
        throw offline(err);
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
        throw offline(err);
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
      const reply = await this.post(cmd, param, await this.getToken());
      if (reply.code === 0) return reply.value as T;
      if (attempt === 0 && AUTH_RSP_CODES.has(reply.error?.rspCode ?? 0)) {
        this.token = null;
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

  // GET endpoints (Snap, FLV) answer an invalid token with JSON or a closed
  // connection instead of rspCode; one retry with a fresh login covers both.
  private async getWithToken(buildPath: (token: string) => string, accept: RegExp, signal?: AbortSignal): Promise<IncomingMessage> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken();
      let res: IncomingMessage;
      try {
        res = await openRequest(this.target, buildPath(encodeURIComponent(token)), { timeoutMs: this.timeoutMs, signal });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt === 0) {
          this.token = null;
          continue;
        }
        throw offline(err);
      }
      if (res.statusCode === 200 && accept.test(String(res.headers['content-type'] ?? ''))) return res;
      res.resume();
      if (res.statusCode === 503) throw new CameraError('camera_offline', 'camera unavailable (HTTP 503)');
      if (attempt === 0) {
        this.token = null;
        continue;
      }
      throw new CameraError('camera_error', `unexpected response (HTTP ${res.statusCode})`);
    }
    throw new CameraError('camera_error', 'unexpected response');
  }

  async snapshot(): Promise<Buffer> {
    const res = await this.getWithToken(
      (t) => `/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=${randomBytes(6).toString('hex')}&token=${t}`,
      /^image\/jpeg/,
    );
    try {
      return await readBody(res, 8 * 1024 * 1024);
    } catch (err) {
      throw offline(err);
    }
  }

  async openLive(quality: 'sub' | 'main', signal: AbortSignal): Promise<IncomingMessage> {
    return this.getWithToken(
      (t) => `/flv?port=1935&app=bcs&stream=channel0_${quality}.bcs&token=${t}`,
      /^video\/x-flv/,
      signal,
    );
  }
}
