import { logger } from '../logger';
import { parseProxyEvents, type ProxyEvent } from '../recordings/detection';
import { CATEGORIES } from './analyses';
import { DayCache } from './dayCache';
import { getProxyClient, proxyPath, ProxyError } from './client';
import { proxyHub } from './stream';
import type { CamKey } from '../fleet';

// cam-proxy's person, vehicle and pet events of a camera's day, for the
// cards' per-type counts ("Person 2x", Klaus 2026-10-04) and their
// thumbnails' version. One request per AI type (GET /events?kind=…): a busy
// day has more motion events than one answer holds. A camera event or an
// analysis for the camera drops its cached days, so the reload it causes
// (pages reload the day on those messages) sees it.

const FETCH_TIMEOUT_MS = 3000;
const LIMIT = 1000;

// The day's AI events, oldest first (forDay); null when the proxy can't tell
// (an error, or a camera without one).
class AiEventStore extends DayCache<ProxyEvent> {
  constructor() {
    super({
      async fetch(cam, win) {
        const client = getProxyClient(cam);
        if (!client) return null;
        const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        const lists = await Promise.all(
          CATEGORIES.map((kind) => client.json<unknown>(proxyPath(cam, '/events'), { from: win[0], to: win[1], kind, limit: LIMIT }, { timeoutMs: FETCH_TIMEOUT_MS, signal })),
        );
        return lists.flatMap(parseProxyEvents).sort((a, b) => a.start - b.start || a.id - b.id);
      },
      failure(cam, err) {
        logger.debug({ cameraId: cam, code: err instanceof ProxyError ? err.code : 'error' }, 'proxy_ai_events_unavailable');
        return 'failed';
      },
    });
  }
}

let store = new AiEventStore();
export const getAiEventStore = (): AiEventStore => store;
export function resetAiEventStore(): void {
  store = new AiEventStore();
}

// A camera's new event or analysis: its days are read again.
proxyHub.on('message', (m: { cam: CamKey; type: string }) => {
  if (m.type === 'camera-event' || m.type === 'analysis' || m.type === 'reset') store.invalidate(m.cam);
});
