import { WebSocket, type Dispatcher } from 'undici';
import type { CamKey } from '../fleet';
import { proxyEndpoint, secretAllowed } from '../secretGuard';
import { groupDispatcher } from '../tls/groupCa';
import { ProxyError, proxyCameraId } from './client';
import { groupOf } from './groups';

// Live video of a camera reached through its proxy (cam-proxy spec
// 2026-10-30-camera-onboarding-design §10.3): cams → proxy is a WebSocket on
// the proxy's own address, `GET /api/cameras/:cam/live?stream=…[&codecs=…]`
// with the client token as a Bearer header (never in the URL). The proxy
// sends one text `{"type":"mse","value":"video/mp4; codecs=\"…\""}`, then
// fMP4 as binary messages; or `{"type":"error","value":<code>}` and a close.

export const LIVE_CODECS = /^[A-Za-z0-9.,]{1,512}$/;
export const MSE_MIME = /^video\/mp4; codecs="[A-Za-z0-9.,]{1,512}"$/;
const ERROR_VALUE = /^[a-z_]{1,64}$/;
const START_MS = 10_000;

export interface ProxyLive {
  mime: string;
  chunks: AsyncIterable<Uint8Array>;
  close(): void;
}

// A queue the socket fills and the route drains, ended by either side.
function chunkQueue(): { push(c: Uint8Array): void; end(): void; iterable: AsyncIterable<Uint8Array> } {
  const items: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const signal = () => {
    wake?.();
    wake = null;
  };
  return {
    push(c) {
      if (ended) return;
      items.push(c);
      signal();
    },
    end() {
      ended = true;
      signal();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (items.length) {
            yield items.shift()!;
            continue;
          }
          if (ended) return;
          await new Promise<void>((r) => (wake = r));
        }
      },
    },
  };
}

export async function openProxyLive(id: CamKey, quality: 'sub' | 'main', codecs: string | undefined, signal: AbortSignal): Promise<ProxyLive> {
  const g = groupOf(id);
  if (!g) throw new ProxyError('proxy_unreachable', 'the camera has no cam-proxy');
  const host = new URL(g.url).host;
  // The token goes only to the endpoint an admin confirmed (cams-admin mode), as ProxyClient.open.
  if (!secretAllowed(g.token, proxyEndpoint({ url: g.url, pins: g.pins, tlsServername: g.tlsServername }))) {
    throw new ProxyError('proxy_unconfirmed', `cam-proxy ${host}: not a confirmed endpoint for this token`);
  }
  let dispatcher: Dispatcher | undefined;
  try {
    dispatcher = await groupDispatcher(g);
  } catch {
    throw new ProxyError('proxy_unreachable', `cam-proxy ${host}: its site CA is not verified`);
  }
  signal.throwIfAborted();
  const u = new URL(g.url);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/api/cameras/${encodeURIComponent(proxyCameraId(id))}/live`;
  u.search = '';
  u.searchParams.set('stream', quality);
  if (codecs !== undefined) u.searchParams.set('codecs', codecs);
  const ws = new WebSocket(u, { headers: { Authorization: `Bearer ${g.token}` }, ...(dispatcher && { dispatcher }) });
  ws.binaryType = 'arraybuffer';
  const q = chunkQueue();
  let opened = false;
  let started = false;
  let refusal: string | undefined;
  const close = () => {
    q.end();
    if (ws.readyState === ws.CONNECTING || ws.readyState === ws.OPEN) {
      try {
        ws.close(1000);
      } catch {
        // already closing
      }
    }
  };
  signal.addEventListener('abort', close, { once: true });
  return new Promise<ProxyLive>((resolve, reject) => {
    const fail = (err: ProxyError) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', close);
      close();
      reject(err);
    };
    const timer = setTimeout(() => fail(new ProxyError('proxy_error', `cam-proxy ${host}: no live stream within ${START_MS / 1000} s`, 503, 'stream_unavailable')), START_MS);
    ws.addEventListener('open', () => {
      opened = true;
    });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        let m: { type?: unknown; value?: unknown } | null = null;
        try {
          m = JSON.parse(ev.data) as { type?: unknown; value?: unknown };
        } catch {
          m = null;
        }
        if (!started && m?.type === 'mse' && typeof m.value === 'string' && MSE_MIME.test(m.value)) {
          started = true;
          clearTimeout(timer);
          resolve({ mime: m.value, chunks: q.iterable, close });
          return;
        }
        if (m?.type === 'error') {
          refusal = typeof m.value === 'string' && ERROR_VALUE.test(m.value) ? m.value : 'stream_unavailable';
          if (!started) fail(new ProxyError('proxy_error', `cam-proxy ${host}: live refused (${refusal})`, 503, refusal));
          else close();
        }
        return; // any other text is not media
      }
      if (!started) return; // bytes before the MIME type are dropped
      q.push(new Uint8Array(ev.data as ArrayBuffer));
    });
    ws.addEventListener('error', () => {
      if (!started && !opened) fail(new ProxyError('proxy_unreachable', `cam-proxy ${host}: live socket refused or unreachable`));
    });
    ws.addEventListener('close', () => {
      q.end();
      signal.removeEventListener('abort', close);
      if (started) return;
      if (!opened) fail(new ProxyError('proxy_unreachable', `cam-proxy ${host}: live socket refused or unreachable`));
      else fail(new ProxyError('proxy_error', `cam-proxy ${host}: live closed before it started`, 503, refusal ?? 'stream_unavailable'));
    });
  });
}
