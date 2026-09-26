// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { enterFullscreen } from './fullscreen';

describe('enterFullscreen', () => {
  it('uses the container when the Fullscreen API is available', async () => {
    const container = document.createElement('div');
    container.requestFullscreen = vi.fn(async () => {});
    expect(await enterFullscreen(container, document.createElement('video'))).toBe('container');
    expect(container.requestFullscreen).toHaveBeenCalled();
  });

  // iPhone Safari: no element fullscreen, only the video's own player.
  it('falls back to the video element (webkitEnterFullscreen) when the container cannot go fullscreen', async () => {
    const container = document.createElement('div');
    (container as unknown as { requestFullscreen?: unknown }).requestFullscreen = undefined;
    const video = document.createElement('video') as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    video.webkitEnterFullscreen = vi.fn();
    expect(await enterFullscreen(container, video)).toBe('video');
    expect(video.webkitEnterFullscreen).toHaveBeenCalled();
  });

  it('falls back to the video when requestFullscreen rejects', async () => {
    const container = document.createElement('div');
    container.requestFullscreen = vi.fn(async () => { throw new Error('not allowed'); });
    const video = document.createElement('video') as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    video.webkitEnterFullscreen = vi.fn();
    expect(await enterFullscreen(container, video)).toBe('video');
  });

  it('reports none when nothing can go fullscreen', async () => {
    const container = document.createElement('div');
    (container as unknown as { requestFullscreen?: unknown }).requestFullscreen = undefined;
    expect(await enterFullscreen(container, null)).toBe('none');
  });
});
