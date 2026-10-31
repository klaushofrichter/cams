import type { Player } from './liveSession';

// Live video of a camera behind a cam-proxy (spec 2026-10-30 §10.3): cams
// relays the proxy's fMP4 (go2rtc's MSE stream) as one chunked HTTP
// response; this plays it through Media Source Extensions, behind the same
// Player interface LiveSession drives as the FLV player. A finished body (the
// 9-minute swap, the proxy or cams ending it) counts as a failure, so the
// session reconnects instead of freezing on the last frame.

const MAX_LATENCY_S = 1.5; // further behind the newest frame than this: jump
const JUMP_BEHIND_S = 0.3; // to this far before the end
const KEEP_BEHIND_S = 30; // drop what lies more than this behind the playhead,
const TRIM_SLACK_S = 10; // once that is this much more (a removal ends on a keyframe)

type MS = typeof MediaSource;
const mediaSourceClass = (): MS | undefined => (globalThis as { ManagedMediaSource?: MS }).ManagedMediaSource ?? globalThis.MediaSource;

export function fmp4Player(url: string): Player {
  const ctl = new AbortController();
  const queue: Uint8Array[] = [];
  let video: HTMLVideoElement | null = null;
  let source: MediaSource | null = null;
  let sb: SourceBuffer | null = null;
  let objectUrl: string | null = null;
  let failed = false;
  let destroyed = false;
  let onFail: (() => void) | null = null;

  const fail = () => {
    if (failed || destroyed) return;
    failed = true;
    onFail?.();
  };

  // Keep latency low and the buffer bounded, then append the next chunk.
  const pump = () => {
    if (!sb || sb.updating || failed || destroyed || !video) return;
    const b = video.buffered;
    if (b.length) {
      const end = b.end(b.length - 1);
      if (end - video.currentTime > MAX_LATENCY_S) video.currentTime = end - JUMP_BEHIND_S;
      const start = b.start(0);
      if (video.currentTime - start > KEEP_BEHIND_S + TRIM_SLACK_S) {
        try {
          sb.remove(start, video.currentTime - KEEP_BEHIND_S);
          return; // its updateend pumps again
        } catch {
          // a remove the browser refuses: append anyway
        }
      }
    }
    const next = queue.shift();
    if (!next) return;
    try {
      sb.appendBuffer(next as BufferSource);
    } catch {
      fail(); // QuotaExceededError, or a source that closed
    }
  };

  const run = async () => {
    const Source = mediaSourceClass();
    if (!Source || !source) return fail();
    const opened = new Promise<void>((resolve) => {
      if (source!.readyState === 'open') resolve();
      else source!.addEventListener('sourceopen', () => resolve(), { once: true });
    });
    let res: Response;
    try {
      res = await fetch(url, { signal: ctl.signal, credentials: 'same-origin', cache: 'no-store' });
    } catch {
      return fail();
    }
    const type = res.headers.get('content-type') ?? '';
    if (res.status !== 200 || !res.body || !Source.isTypeSupported(type)) {
      void res.body?.cancel().catch(() => undefined);
      return fail();
    }
    await opened;
    if (destroyed) return;
    try {
      sb = source.addSourceBuffer(type);
      sb.mode = 'segments';
    } catch {
      return fail();
    }
    sb.addEventListener('updateend', pump);
    sb.addEventListener('error', fail);
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || destroyed) break;
        queue.push(value);
        pump();
      }
    } catch {
      // aborted or cut
    }
    fail();
  };

  return {
    attach: (v) => {
      video = v;
      const Source = mediaSourceClass();
      if (!Source) return;
      source = new Source();
      objectUrl = URL.createObjectURL(source as unknown as Blob);
      // Safari's ManagedMediaSource plays only with remote playback off.
      v.disableRemotePlayback = true;
      v.src = objectUrl;
    },
    load: () => void run(),
    play: () => {
      void video?.play()?.catch(() => {});
    },
    destroy: () => {
      destroyed = true;
      ctl.abort();
      queue.length = 0;
      sb?.removeEventListener('updateend', pump);
      sb?.removeEventListener('error', fail);
      if (video) {
        video.removeAttribute('src');
        try {
          video.load();
        } catch {
          // a video already gone
        }
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      source = sb = null;
    },
    onFailure: (cb) => {
      onFail = cb;
    },
  };
}
