import mpegts from 'mpegts.js';
import type { Player } from './liveSession';

// Adapts mpegts.js to the Player interface LiveSession drives. A finished
// load (the server or camera ended the stream) counts as a failure, so the
// session reconnects instead of freezing on the last frame.
export function mpegtsPlayer(url: string): Player {
  const p = mpegts.createPlayer(
    { type: 'flv', isLive: true, url, hasAudio: true, hasVideo: true },
    {
      enableStashBuffer: false,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 1.5,
      liveBufferLatencyMinRemain: 0.3,
      lazyLoad: false,
    },
  );
  let failed = false;
  return {
    attach: (video) => p.attachMediaElement(video),
    load: () => p.load(),
    play: () => {
      void Promise.resolve(p.play()).catch(() => {});
    },
    destroy: () => {
      try {
        p.pause();
        p.unload();
        p.detachMediaElement();
      } finally {
        p.destroy();
      }
    },
    onFailure: (cb) => {
      const once = () => {
        if (failed) return;
        failed = true;
        cb();
      };
      p.on(mpegts.Events.ERROR, once);
      p.on(mpegts.Events.LOADING_COMPLETE, once);
    },
  };
}
