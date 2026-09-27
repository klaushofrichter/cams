import { Router, Request, Response } from 'express';
import { getRecordings } from '../recordings/service';
import { proxyHub, proxyStates } from '../proxy/stream';

// The cam-proxy relay to browsers (Plan 6): the proxy's events, as a hint
// to reload through the usual APIs. No URLs or tokens travel here.
export const eventsRouter = Router();

const MAX_CLIENTS = 20;
const PING_MS = 25_000;
let clients = 0;

interface ProxyMessage {
  cam: string;
  type: string;
  data: Record<string, unknown>;
}

const tsOf = (m: ProxyMessage): number | null => {
  const v = m.data.ts ?? m.data.start;
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
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.write('retry: 5000\n\n');
  for (const s of proxyStates()) send('proxy', s);
  const onState = (s: { cam: string; up: boolean }) => send('proxy', s);
  const onMessage = (m: ProxyMessage) => {
    if (m.type === 'camera-event' || m.type === 'clip' || m.type === 'reset' || m.type === 'camera-status') send('change', { cam: m.cam, type: m.type, ts: tsOf(m) });
  };
  proxyHub.on('state', onState);
  proxyHub.on('message', onMessage);
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
  req.on('close', () => {
    clients--;
    clearInterval(ping);
    proxyHub.off('state', onState);
    proxyHub.off('message', onMessage);
  });
});
