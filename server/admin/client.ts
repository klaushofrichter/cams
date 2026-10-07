// The signed cams-admin client (contract cams-v1, M §9.2): every request
// signed with the instance key; every answer's X-Cams-Admin-Sig verified
// against the pinned server keys BEFORE its status is looked at; a signed
// 401 clock_skew sets the clock offset (the Pi has no RTC) and the request
// is retried once. Answers ≤ 1 MiB. Logs: path, status, error code only.
import { logger } from '../logger';
import type { AdminKeyFile } from './keyfile';
import { answerText, newNonce, privateFromB64, requestText, signText, verifyWithAny } from './sign';
import type { KeyObject } from 'crypto';

export type AdminErrorCode = 'unreachable' | 'unsigned' | 'bad_answer' | 'refused' | 'too_large';
export class AdminError extends Error {
  constructor(
    public code: AdminErrorCode,
    public status?: number,
    public error?: string,
    public detail?: Record<string, unknown>,
  ) {
    super(`cams-admin ${code}${status ? ` ${status}` : ''}${error ? ` ${error}` : ''}`);
    this.name = 'AdminError';
  }
}

export type TrustFieldName = 'proxyUrl' | 'caFingerprints' | 'proxyTlsServername' | 'host' | 'protocol' | 'tlsServername';
export interface CamsReport {
  v: 1;
  mode: 'file' | 'shadow' | 'cams-admin';
  version: string;
  appliedRevision: string | null;
  cacheVerifiedAt: number | null;
  lastPullAt: number | null;
  held: { accountId: string; camsId: string; fields: TrustFieldName[] }[];
  keptOld: { accountId: string; camsId: string; fields: TrustFieldName[] }[];
  shadow: { accountId: string; differences: number; items: string[] } | null;
  tokens: { managed: number; pending: number; legacy: number };
  problems: { code: string; accountId?: string; detail?: string }[];
}

const MAX_ANSWER = 1024 * 1024;
const MAX_SKEW_MS = 7 * 86_400_000;

export class AdminClient {
  private offset = 0;
  private readonly priv: KeyObject;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl?: string;

  constructor(
    private readonly k: AdminKeyFile,
    o: { baseUrl?: string; timeoutMs?: number; now?: () => number; fetchImpl?: typeof fetch } = {},
  ) {
    this.priv = privateFromB64(k.privateKey);
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.now = o.now ?? Date.now;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.baseUrl = o.baseUrl;
  }

  offsetMs(): number {
    return this.offset;
  }

  private base(): string {
    return (this.baseUrl ?? process.env.CAMS_ADMIN_URL ?? this.k.url).replace(/\/+$/, '');
  }

  // One signed request; the answer verified. Retries once on a signed clock_skew.
  private async request(method: 'GET' | 'POST', path: string, body: unknown, headers: Record<string, string> = {}, retried = false): Promise<{ status: number; body: Buffer; etag: string | null }> {
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
    const ts = this.now() + this.offset;
    const nonce = newNonce();
    const sig = signText(this.priv, requestText(method, path, ts, nonce, bytes));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let status: number;
    let answer: Buffer;
    let etag: string | null;
    let answerSig: string | null;
    try {
      const res = await this.fetchImpl(`${this.base()}${path}`, {
        method,
        headers: {
          'X-Cams-Instance': this.k.instanceId,
          'X-Cams-Key': this.k.keyId,
          'X-Cams-Ts': String(ts),
          'X-Cams-Nonce': nonce,
          'X-Cams-Sig': sig,
          ...(bytes.length ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(bytes.length ? { body: bytes } : {}),
        signal: ctl.signal,
        redirect: 'manual',
      });
      status = res.status;
      etag = res.headers.get('etag');
      answerSig = res.headers.get('x-cams-admin-sig');
      answer = await readCapped(res, ctl);
    } catch (err) {
      if (err instanceof AdminError) {
        logger.warn({ path, code: err.code }, 'admin_request_failed');
        throw err;
      }
      logger.warn({ path, code: 'unreachable' }, 'admin_request_failed');
      throw new AdminError('unreachable');
    } finally {
      clearTimeout(timer);
    }
    if (!verifyWithAny(this.k.serverKeys, answerText(status, nonce, answer), answerSig)) {
      logger.warn({ path, status }, 'admin_answer_unsigned');
      throw new AdminError('unsigned', status);
    }
    if (status >= 400) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = answer.length ? (JSON.parse(answer.toString('utf8')) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      const error = typeof parsed.error === 'string' ? parsed.error.slice(0, 64) : undefined;
      if (status === 401 && error === 'clock_skew' && typeof parsed.serverTime === 'number' && !retried) {
        const offset = parsed.serverTime - this.now();
        if (Math.abs(offset) <= MAX_SKEW_MS) {
          this.offset = offset;
          logger.warn({ path, offsetS: Math.round(offset / 1000) }, 'admin_clock_skew');
          return this.request(method, path, body, headers, true);
        }
      }
      logger.warn({ path, status, error }, 'admin_request_refused');
      throw new AdminError('refused', status, error, parsed);
    }
    return { status, body: answer, etag };
  }

  private json(r: { body: Buffer }): Record<string, unknown> {
    try {
      const v = JSON.parse(r.body.toString('utf8')) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // below
    }
    throw new AdminError('bad_answer');
  }

  async getConfig(etag: string | null): Promise<{ status: 200; body: unknown; etag: string | null } | { status: 304 }> {
    const r = await this.request('GET', '/cams/v1/config', undefined, etag ? { 'If-None-Match': `"${etag}"` } : {});
    if (r.status === 304) return { status: 304 };
    if (r.status !== 200) throw new AdminError('bad_answer', r.status);
    return { status: 200, body: this.json(r), etag: r.etag ? r.etag.replace(/^W\//, '').replace(/^"|"$/g, '') : null };
  }

  async registerToken(proxyId: string, kind: 'client' | 'admin', hash: string): Promise<{ status: 200 | 201; tokenId: string; state: string; label: string }> {
    const r = await this.request('POST', '/cams/v1/tokens', { v: 1, proxyId, kind, hash });
    const b = this.json(r);
    if ((r.status !== 200 && r.status !== 201) || typeof b.tokenId !== 'string' || typeof b.state !== 'string') throw new AdminError('bad_answer', r.status);
    return { status: r.status, tokenId: b.tokenId, state: b.state, label: typeof b.label === 'string' ? b.label : '' };
  }

  async retireToken(tokenId: string, hours?: number): Promise<{ tokenId: string; state: 'retiring'; retireAt: number }> {
    const r = await this.request('POST', `/cams/v1/tokens/${encodeURIComponent(tokenId)}/retire`, { v: 1, ...(hours !== undefined && { hours }) });
    const b = this.json(r);
    if (b.state !== 'retiring' || typeof b.retireAt !== 'number') throw new AdminError('bad_answer', r.status);
    return { tokenId: String(b.tokenId), state: 'retiring', retireAt: b.retireAt };
  }

  async report(rep: CamsReport): Promise<{ changed: boolean; revision: string }> {
    const r = await this.request('POST', '/cams/v1/report', rep);
    const b = this.json(r);
    if (typeof b.changed !== 'boolean' || typeof b.revision !== 'string') throw new AdminError('bad_answer', r.status);
    return { changed: b.changed, revision: b.revision };
  }
}

// The body, read up to MAX_ANSWER bytes; a longer one aborts the transfer.
async function readCapped(res: Response, ctl: AbortController): Promise<Buffer> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_ANSWER) {
    ctl.abort();
    throw new AdminError('too_large', res.status);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let n = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_ANSWER) {
      void reader.cancel().catch(() => undefined);
      ctl.abort();
      throw new AdminError('too_large', res.status);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
