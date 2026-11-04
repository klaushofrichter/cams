import type { Readable } from 'stream';
import { getProxyClient, proxyPath, requireProxyClient } from '../proxy/client';
import type { CamKey } from '../fleet';
import { contentLength, nodeBody } from '../httpBody';

// A camera's recording from its cam-proxy (Plan 6): the clip the camera
// uploaded by FTP that covers the event's start, when the camera itself
// refuses the download. The proxy can be switched off between finding a clip
// or still and opening it: requireProxyClient then throws proxy_unreachable.

interface ProxyClip {
  id: number;
  start: number;
  end: number | null;
  origin?: string; // 'ftp' or 'camera' (fetched); an older proxy may not say
}

// The clip of an event: cam-proxy's rule for one recording (its
// src/inventory/match.ts, sameRecording), closest start first.
// - The clip that holds the event's start. The upload is named by the same
//   camera clock as the SD-card recording, so a clip may start up to 5 s after
//   the event; one that ended before the event is another recording.
// - An FTP clip that starts more than 5 s and at most 10 s after the event,
//   and before the event's end: an E1 Outdoor Pro's upload starts about 8 s
//   after its SD recording (measured 2026-11-03/04). Only a clip that says it
//   came by FTP: a fetched one starts exactly where its recording does.
// Anything later is another recording (an RLC-1224A's clips at +13 s and later)
// and never used: it would be cached under this event's key. A late clip is
// this event's own, so it may be, though it lacks the event's first seconds
// (the SD file is asked first; a composition fills them with stills or cards).
const SLACK_MS = 5_000;
const LATE_FTP_MS = 10_000;

function holdsStart(c: ProxyClip, start: number): boolean {
  return c.start <= start + SLACK_MS && (c.end ?? c.start) >= start;
}

function lateFtpCopy(c: ProxyClip, start: number, end: number): boolean {
  return c.origin === 'ftp' && c.start > start + SLACK_MS && c.start <= start + LATE_FTP_MS && c.start < end;
}

export async function findProxyClip(cameraId: CamKey, start: number, end: number): Promise<ProxyClip | null> {
  const client = getProxyClient(cameraId);
  if (!client) return null;
  const clips = await client.json<ProxyClip[]>(proxyPath(cameraId, '/clips'), { from: start - SLACK_MS, to: Math.max(end, start) });
  const valid = clips.filter((c) => Number.isSafeInteger(c.id) && (holdsStart(c, start) || lateFtpCopy(c, start, end)));
  return valid.sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start))[0] ?? null;
}

export async function openProxyClip(cameraId: CamKey, id: number, signal?: AbortSignal): Promise<{ stream: Readable; size: number | null }> {
  const client = requireProxyClient(cameraId);
  const res = await client.open(proxyPath(cameraId, `/clips/${id}.mp4`), undefined, { signal, timeoutMs: 30_000, idleMs: 30_000 });
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error(`cam-proxy ${client.host()} answered ${res.status} for clip ${id}`);
  }
  return { stream: nodeBody(res), size: contentLength(res.headers.get('content-length')) };
}

// The first still the proxy has in [from, to] (unix ms), for thumbnails.
export async function findProxyStill(cameraId: CamKey, from: number, to: number): Promise<number | null> {
  const client = getProxyClient(cameraId);
  if (!client) return null;
  const stills = await client.json<number[]>(proxyPath(cameraId, '/stills'), { from, to });
  const ts = stills.find((t) => Number.isSafeInteger(t) && t >= from && t <= to);
  return ts ?? null;
}

export async function openProxyStill(cameraId: CamKey, ts: number): Promise<Readable> {
  const client = requireProxyClient(cameraId);
  const res = await client.open(proxyPath(cameraId, `/stills/${Math.trunc(ts)}.jpg`), undefined, { idleMs: 10_000 });
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error(`cam-proxy ${client.host()} answered ${res.status} for still ${ts}`);
  }
  return nodeBody(res);
}
