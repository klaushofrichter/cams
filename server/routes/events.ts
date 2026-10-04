import { Router, Request, Response } from 'express';
import { getRecordings } from '../recordings/service';
import { proxyHub, proxyStates } from '../proxy/stream';
import { nameEvents } from '../cameraRegistry';
import '../proxy/names'; // keeps the cameras' names from their cam-proxies
import '../proxy/stillChecks'; // drops a camera's cached checks on a new one

// The cam-proxy relay to browsers (Plan 6): the proxy's events, as a hint
// to reload through the usual APIs. No URLs or tokens travel here.
export const eventsRouter = Router();

const MAX_CLIENTS = 20;
const PING_MS = 25_000;
let clients = 0;
const open = new Set<Response>();

// On shutdown (SIGTERM): end every relay, so the old revision isn't held
// open until Knative cuts it (issue #38).
export function closeEventStreams(): void {
  for (const res of open) res.end();
}
export const eventStreamCount = () => clients;

interface ProxyMessage {
  cam: string;
  type: string;
  data: Record<string, unknown>;
}

const tsOf = (m: ProxyMessage): number | null => {
  const v = m.data.ts ?? m.data.start ?? m.data.stillTs;
  return typeof v === 'number' ? v : null;
};

// Recordings of that day changed: the next /events fetch asks the camera again.
proxyHub.on('message', (m: ProxyMessage) => {
  if (m.type === 'clip' || (m.type === 'camera-event' && m.data.phase === 'end') || m.type === 'reset') {
    void getRecordings()
      .invalidateAround(m.cam, tsOf(m) ?? Date.now())
      .catch(() => undefined);
  }
});

eventsRouter.get('/api/events/stream', (req: Request, res: Response) => {
  if (clients >= MAX_CLIENTS) {
    res.status(503).json({ error: 'too_many_streams' });
    return;
  }
  clients++;
  open.add(res);
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.write('retry: 5000\n\n');
  for (const s of proxyStates()) send('proxy', s);
  const onState = (s: { cam: string; up: boolean }) => send('proxy', s);
  const onMessage = (m: ProxyMessage) => {
    // A new analysis (Vision): pages reload the day, and its cards get their
    // badge. A new still check (cams #179): the Timeline's marks and list, and
    // the cards it confirms.
    if (m.type === 'camera-event' || m.type === 'clip' || m.type === 'reset' || m.type === 'camera-status' || m.type === 'analysis' || m.type === 'still-check') {
      // A camera event also says what (person, motion, …) and whether it
      // started or ended: the browser's live notification (Klaus, 2026-09-28).
      const extra =
        m.type === 'camera-event' && typeof m.data.kind === 'string' && (m.data.phase === 'start' || m.data.phase === 'end')
          ? { kind: m.data.kind, phase: m.data.phase }
          : {};
      send('change', { cam: m.cam, type: m.type, ts: tsOf(m), ...extra });
    }
  };
  // A camera's proxy was switched on or off (Settings): re-read /api/cameras.
  const onCameras = () => send('cameras', {});
  // A camera's shown name changed (renamed here, in the Reolink app or on the
  // camera; or its proxy came or went): pages switch to it, no reload.
  const onName = (n: { cam: string; name: string }) => send('camera', n);
  nameEvents.on('name', onName);
  proxyHub.on('state', onState);
  proxyHub.on('message', onMessage);
  proxyHub.on('cameras', onCameras);
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clients--;
    open.delete(res);
    clearInterval(ping);
    proxyHub.off('state', onState);
    proxyHub.off('message', onMessage);
    proxyHub.off('cameras', onCameras);
    nameEvents.off('name', onName);
  };
  req.on('close', finish);
  res.on('finish', finish);
});
