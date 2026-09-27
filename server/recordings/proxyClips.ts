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

// The clip containing `start`, else the one starting nearest to it (within a
// minute: the camera's recording starts a few seconds before its event).
export async function findProxyClip(cameraId: string, start: number, end: number): Promise<ProxyClip | null> {
  const client = getProxyClient(cameraId);
  if (!client) return null;
  const clips = await client.json<ProxyClip[]>(`/api/cameras/${encodeURIComponent(proxyCameraId(cameraId))}/clips`, { from: start - 60_000, to: Math.max(end, start) });
  const containing = clips.find((c) => c.start <= start && (c.end ?? c.start) >= start);
  if (containing) return containing;
  const near = clips.map((c) => ({ c, d: Math.abs(c.start - start) })).filter((x) => x.d <= 60_000).sort((a, b) => a.d - b.d)[0];
  return near?.c ?? null;
}

export async function openProxyClip(cameraId: string, id: number, signal?: AbortSignal): Promise<{ stream: Readable; size: number | null }> {
  const client = getProxyClient(cameraId)!;
  const res = await client.open(`/api/cameras/${encodeURIComponent(proxyCameraId(cameraId))}/clips/${id}.mp4`, undefined, { signal, timeoutMs: 30_000 });
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error(`cam-proxy ${client.host()} answered ${res.status} for clip ${id}`);
  }
  const cl = res.headers.get('content-length');
  return { stream: Readable.fromWeb(res.body as import('stream/web').ReadableStream), size: cl && /^\d+$/.test(cl) ? Number(cl) : null };
}
