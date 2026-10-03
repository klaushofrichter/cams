import { Readable } from 'stream';
import { logger } from '../logger';
import { errorBody, getProxyClient, proxyCameraId, ProxyError, type ProxyClient } from '../proxy/client';
import { RecordingError } from './errors';

// A camera's SD-card recordings through its cam-proxy's recordings API
// (cam-proxy spec 2026-10-02-baichuan-recordings-design, section 2): the proxy
// lists them with the camera's Search, one Search at a time, and fetches the
// files over Baichuan, which works while the camera refuses HTTP Download.

export interface ProxyRecording {
  id: string; // the camera's file name, without the folder
  start: number; // unix ms
  end: number;
  stream: 'sub' | 'main';
  size: number; // bytes
  kinds: string[];
  clipId: number | null; // the proxy's FTP copy of the same recording
}

// cam-proxy's pattern for an SD file name (at most 128 characters). An id is
// used in a URL later, so nothing else passes.
const REC_ID = /^Rec[MS][0-9A-Za-z]{2}_(DST)?\d{8}_\d{6}_\d{6}_[0-9A-Za-z_]+\.mp4$/;

// The proxy can be switched off between two calls.
function clientFor(cameraId: string): ProxyClient {
  const client = getProxyClient(cameraId);
  if (!client) throw new ProxyError('proxy_unreachable', 'the camera has no cam-proxy in use');
  return client;
}

function base(cameraId: string): string {
  return `/api/cameras/${encodeURIComponent(proxyCameraId(cameraId))}/recordings`;
}

function isRecording(x: unknown, stream: 'sub' | 'main'): boolean {
  const r = x as Partial<ProxyRecording> | null;
  return (
    !!r &&
    typeof r.id === 'string' &&
    r.id.length <= 128 &&
    REC_ID.test(r.id) &&
    r.stream === stream &&
    Number.isSafeInteger(r.start) &&
    Number.isSafeInteger(r.end) &&
    Number.isSafeInteger(r.size) &&
    (r.size as number) >= 0
  );
}

// The recordings of one stream that overlap [from, to] (unix ms). Entries that
// aren't a well-formed recording of that stream are dropped.
export async function listProxyRecordings(cameraId: string, from: number, to: number, stream: 'sub' | 'main', signal?: AbortSignal): Promise<ProxyRecording[]> {
  return listWith(cameraId, { from, to, stream }, stream, signal);
}

// The longest cams waits out a busy proxy's Retry-After.
const BUSY_WAIT_MAX_MS = 5000;

// A wait that ends early, with the signal's reason, when the viewer leaves.
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// 503 recordings_unavailable busy: the proxy's Search queue is full. One retry
// after its Retry-After (at most 5 s, cut short by `signal`); a second busy
// answer is the caller's.
async function listWith(cameraId: string, query: Record<string, string | number>, stream: 'sub' | 'main', signal?: AbortSignal): Promise<ProxyRecording[]> {
  try {
    return await listOnce(cameraId, query, stream, signal);
  } catch (err) {
    if (!(err instanceof ProxyError) || err.status !== 503 || err.reason !== 'busy') throw err;
    await pause(Math.min((err.retryAfterS ?? 1) * 1000, BUSY_WAIT_MAX_MS), signal);
    return listOnce(cameraId, query, stream, signal);
  }
}

// Per camera: until when its proxy is taken for an older one (it answered 400
// to `date=`), so a cold day costs 2 requests, not 4.
const LEGACY_PROXY_MS = 10 * 60_000;
const legacyUntil = new Map<string, number>();

export function resetLegacyProxies(): void {
  legacyUntil.clear();
}

// One camera-local day (YYYY-MM-DD) of one stream, with a recording that
// started the day before and runs past midnight into it: cam-proxy's `date`
// parameter. An older proxy ignores `date`, finds no from/to and answers 400;
// then the same day is asked again as the caller's from/to window, and for ten
// minutes that proxy gets from/to directly.
export async function listProxyDay(cameraId: string, date: string, stream: 'sub' | 'main', fallback: { from: number; to: number }, signal?: AbortSignal): Promise<ProxyRecording[]> {
  const legacy = () => listWith(cameraId, { from: fallback.from, to: fallback.to, stream }, stream, signal);
  if (Date.now() < (legacyUntil.get(cameraId) ?? 0)) return legacy();
  try {
    return await listWith(cameraId, { date, stream }, stream, signal);
  } catch (err) {
    if (!(err instanceof ProxyError) || err.status !== 400) throw err;
    legacyUntil.set(cameraId, Date.now() + LEGACY_PROXY_MS);
    return legacy();
  }
}

async function listOnce(cameraId: string, query: Record<string, string | number>, stream: 'sub' | 'main', signal?: AbortSignal): Promise<ProxyRecording[]> {
  const body = await clientFor(cameraId).json<unknown>(base(cameraId), query, { signal });
  if (!Array.isArray(body)) throw new ProxyError('proxy_error', 'cam-proxy sent a recordings list that is not a list');
  return body
    .filter((x) => isRecording(x, stream))
    .map((x) => {
      const r = x as ProxyRecording;
      return {
        id: r.id,
        start: r.start,
        end: r.end,
        stream: r.stream,
        size: r.size,
        kinds: Array.isArray(r.kinds) ? r.kinds.filter((k): k is string => typeof k === 'string') : [],
        clipId: Number.isSafeInteger(r.clipId) ? r.clipId : null,
      };
    });
}

// The days (YYYY-MM-DD) of a camera-local month (YYYY-MM) with recordings.
export async function listProxyDays(cameraId: string, month: string): Promise<string[]> {
  const body = await clientFor(cameraId).json<{ days?: unknown } | null>(`${base(cameraId)}/days`, { month });
  if (!body || !Array.isArray(body.days)) throw new ProxyError('proxy_error', 'cam-proxy sent a day list without days');
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const days = new Set(body.days.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= last));
  return [...days].sort((a, b) => a - b).map((d) => `${month}-${String(d).padStart(2, '0')}`);
}

// One recording's file, streamed as it arrives (the proxy fetches it over
// Baichuan on the first request). 404 unknown_recording: the recording is
// gone from the SD card, which is final.
// The headers can wait a long while: the proxy fetches one file at a time per
// camera, so a request queued behind a 4K download holds its headers until that
// finishes. The body's idle watchdog (30 s) only starts after the headers.
export const RECORDING_HEADER_TIMEOUT_MS = 120_000;

export async function openProxyRecording(
  cameraId: string,
  id: string,
  signal?: AbortSignal,
  opts: { headerTimeoutMs?: number; idleMs?: number } = {},
): Promise<{ stream: Readable; size: number | null }> {
  const client = clientFor(cameraId);
  const res = await client.open(`${base(cameraId)}/${encodeURIComponent(id)}`, undefined, { signal, timeoutMs: opts.headerTimeoutMs ?? RECORDING_HEADER_TIMEOUT_MS, idleMs: opts.idleMs ?? 30_000 });
  if (!res.ok || !res.body) {
    const { error: upstream, reason } = await errorBody(res);
    if (res.status === 404 && upstream === 'unknown_recording') throw new RecordingError('unknown_clip', 'the recording is gone from the SD card');
    throw new ProxyError('proxy_error', `cam-proxy ${client.host()} answered ${res.status} for a recording`, res.status, upstream, reason);
  }
  const cl = res.headers.get('content-length');
  return { stream: Readable.fromWeb(res.body as import('stream/web').ReadableStream), size: cl && /^\d+$/.test(cl) ? Number(cl) : null };
}

// Whether cams tries its next route after this failure: everything but a
// recording gone from the SD card and the viewer's own abort. 502/503, an
// unreachable proxy, a refused token, a 400 (a bug in cams) and an older
// cam-proxy without the API (a plain 404) all fall back.
export function fallsBack(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  return !(err instanceof RecordingError);
}

// `what`: the clip id, or the day or month being listed. ProxyError messages
// name the proxy's host only, never its token.
export function logProxyFailure(cameraId: string, what: string, err: unknown): void {
  const e = err instanceof ProxyError ? err : undefined;
  const fields = { cameraId, what, code: e?.code ?? 'error', status: e?.status, upstream: e?.upstream, reason: e?.reason, message: (err as Error).message };
  if (e?.status === 400) logger.error(fields, 'proxy_recordings_failed');
  else logger.warn(fields, 'proxy_recordings_failed');
}

// Whether the proxy knows a recording, without a transfer (its HEAD answers
// from the list). Any failure throws a ProxyError: a HEAD has no body, so a
// gone recording and an older proxy's 404 look the same here.
export async function headProxyRecording(cameraId: string, id: string): Promise<void> {
  const client = clientFor(cameraId);
  const res = await client.open(`${base(cameraId)}/${encodeURIComponent(id)}`, undefined, { method: 'HEAD' });
  await res.body?.cancel();
  if (!res.ok) throw new ProxyError('proxy_error', `cam-proxy ${client.host()} answered ${res.status} for a recording`, res.status);
}
