import { Readable } from 'stream';
import { getProxyClient, proxyCameraId } from '../proxy/client';

// A camera's recording from its cam-proxy (Plan 6): the clip the camera
// uploaded by FTP that covers the event's start, when the camera itself
// refuses the download.

interface ProxyClip {
  id: number;
  start: number;
  end: number | null;
}

// The clip containing the event's start. The upload is named by the same
// camera clock as the SD-card recording, so only a few seconds of slack are
// allowed; a clip that ended before the event, or starts later, is another
// recording and never used (it would be cached under this event's key).
const SLACK_MS = 5_000;

export async function findProxyClip(cameraId: string, start: number, end: number): Promise<ProxyClip | null> {
  const client = getProxyClient(cameraId);
  if (!client) return null;
  const clips = await client.json<ProxyClip[]>(`/api/cameras/${encodeURIComponent(proxyCameraId(cameraId))}/clips`, { from: start - SLACK_MS, to: Math.max(end, start) });
  const valid = clips.filter((c) => Number.isSafeInteger(c.id) && c.start <= start + SLACK_MS && (c.end ?? c.start) >= start);
  return valid.sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start))[0] ?? null;
}

export async function openProxyClip(cameraId: string, id: number, signal?: AbortSignal): Promise<{ stream: Readable; size: number | null }> {
  const client = getProxyClient(cameraId)!;
  const res = await client.open(`/api/cameras/${encodeURIComponent(proxyCameraId(cameraId))}/clips/${id}.mp4`, undefined, { signal, timeoutMs: 30_000, idleMs: 30_000 });
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error(`cam-proxy ${client.host()} answered ${res.status} for clip ${id}`);
  }
  const cl = res.headers.get('content-length');
  return { stream: Readable.fromWeb(res.body as import('stream/web').ReadableStream), size: cl && /^\d+$/.test(cl) ? Number(cl) : null };
}
