// web/src/lib/routerVideo.test.ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

// The Video menu entry goes back to the tab's last Video page (Klaus,
// 2026-11-05): its camera, day, moment, interval and play state.
const REC = '/app/video?cam=den&date=2026-09-27&at=1790552160&zoom=1h&play=1';

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  history.replaceState({}, '', '/app/about');
});
afterEach(() => sessionStorage.clear());

describe('the last Video URL of this tab', () => {
  it('follows every Video URL shown, not other pages or the old ones', async () => {
    const r = await import('./router');
    const stop = r.initRouter();
    expect(get(r.lastVideoHref)).toBe('/app/video');
    r.navigate(REC);
    expect(get(r.lastVideoHref)).toBe(REC);
    r.navigate('/app/about');
    r.navigate('/app/live'); // rewritten by the page; its /app/video form counts
    expect(get(r.lastVideoHref)).toBe(REC);
    r.replaceRoute('/app/video?cam=den&date=2026-09-27&at=1790552170&zoom=1h');
    expect(get(r.lastVideoHref)).toBe('/app/video?cam=den&date=2026-09-27&at=1790552170&zoom=1h');
    stop();
  });

  it('live (the brand link) forgets the moment', async () => {
    const r = await import('./router');
    const stop = r.initRouter();
    r.navigate(REC);
    r.navigate('/app/video');
    expect(get(r.lastVideoHref)).toBe('/app/video');
    stop();
  });

  it('survives a reload of the tab', async () => {
    const r1 = await import('./router');
    const stop = r1.initRouter();
    r1.navigate(REC);
    r1.navigate('/app/settings');
    stop();
    vi.resetModules();
    const r2 = await import('./router');
    expect(get(r2.lastVideoHref)).toBe(REC);
  });

  it('ignores a stored value that isn\'t a Video URL', async () => {
    sessionStorage.setItem('cams-video-href', 'https://example.com/app/video');
    const r = await import('./router');
    expect(get(r.lastVideoHref)).toBe('/app/video');
  });
});

describe('videoNavHref', () => {
  it('is the last Video URL', async () => {
    const { videoNavHref } = await import('./router');
    expect(videoNavHref(REC, 'den', '1h')).toBe(REC);
    expect(videoNavHref('/app/video', 'den', '1h')).toBe('/app/video');
    expect(videoNavHref(REC, null, '1h')).toBe(REC);
  });

  it('is live when another camera has been picked since', async () => {
    const { videoNavHref } = await import('./router');
    expect(videoNavHref(REC, 'porch', '1h')).toBe('/app/video');
  });

  it('carries the interval shown now (changed in Settings meanwhile)', async () => {
    const { videoNavHref } = await import('./router');
    expect(videoNavHref(REC, 'den', '10m')).toBe('/app/video?cam=den&date=2026-09-27&at=1790552160&zoom=10m&play=1');
    // A recording URL written before the interval was in the URL gets it.
    expect(videoNavHref('/app/video?cam=den&date=2026-09-27&at=1790552160', 'den', '3h')).toBe('/app/video?cam=den&date=2026-09-27&at=1790552160&zoom=3h');
  });
});

describe('onBeforeNavigate', () => {
  it('lets the page put its exact position into its own entry before another page is pushed', async () => {
    const r = await import('./router');
    const stop = r.initRouter();
    r.navigate('/app/video?cam=den&date=2026-09-27&at=1790552160&zoom=1h');
    const before = history.length;
    const targets: string[] = [];
    const off = r.onBeforeNavigate((t) => {
      targets.push(t.page);
      if (t.page !== 'video') r.replaceRoute('/app/video?cam=den&date=2026-09-27&at=1790552161&zoom=1h');
    });
    r.navigate('/app/about');
    expect(targets).toEqual(['about']);
    expect(history.length).toBe(before + 1);
    expect(get(r.lastVideoHref)).toBe('/app/video?cam=den&date=2026-09-27&at=1790552161&zoom=1h');
    off();
    r.navigate('/app/settings');
    expect(targets).toEqual(['about']);
    stop();
  });
});
