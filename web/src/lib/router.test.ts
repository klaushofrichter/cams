import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, VIDEO_PATH, isActive, parseRoute } from './router';

describe('parseRoute', () => {
  it.each([
    ['/app/video', '', 'video'],
    ['/app/live', '', 'video'],
    ['/app/recordings', '', 'video'],
    ['/app/settings', '', 'settings'],
    ['/app/about', '', 'about'],
    ['/app', '', 'video'],
    ['/app/', '', 'video'],
    // Review focus 5: unknown pages fall back to the video page, never a blank shell.
    ['/app/nope', '', 'video'],
    ['/app/recordings/extra', '', 'video'],
  ])('%s -> %s', (path, search, page) => {
    expect(parseRoute(path, search).page).toBe(page);
  });

  // The Video page (spec 2026-10-04): the URL asks for live or a recording.
  it('reads /app/video: live without a position, a recording with one', () => {
    expect(parseRoute('/app/video', '')).toMatchObject({ page: 'video', panel: 'live', legacy: false });
    expect(parseRoute('/app/video', '?cam=porch')).toMatchObject({ panel: 'live', legacy: false });
    expect(parseRoute('/app/video', '?cam=porch&date=2026-10-01')).toMatchObject({ panel: 'history', legacy: false });
    expect(parseRoute('/app/video', '?cam=porch&at=5000')).toMatchObject({ panel: 'history' });
    expect(parseRoute('/app/video', '?clip=20261001-101010-101030&t=3')).toMatchObject({ panel: 'history' });
  });

  it('keeps the old URLs working: /app/live is live, /app/recordings a recording', () => {
    expect(parseRoute('/app/live', '')).toMatchObject({ page: 'video', panel: 'live', legacy: true });
    expect(parseRoute('/app/live', '?panel=downloads').panel).toBe('live');
    expect(parseRoute('/app/live', '?at=5000').panel).toBe('history'); // an old playback link
    for (const s of ['?panel=events', '?panel=downloads', '?panel=history', '?panel=bogus', '']) {
      expect(parseRoute('/app/recordings', s)).toMatchObject({ page: 'video', panel: 'history', legacy: true });
    }
    expect(parseRoute('/app/nope', '')).toMatchObject({ page: 'video', panel: 'live', legacy: true });
  });

  it('marks only other pages as not legacy', () => {
    expect(parseRoute('/app/settings', '').legacy).toBe(false);
  });

  it('keeps the query params', () => {
    expect(parseRoute('/app/recordings', '?cam=cam1&t=x').params.get('cam')).toBe('cam1');
  });
});

describe('navigation items', () => {
  it('lists the menu entries in order: one Video entry (Klaus, 2026-10-04)', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Video', 'Timeline', 'Archive', 'Settings', 'About']);
    expect(NAV_ITEMS[0]).toMatchObject({ id: 'video', href: VIDEO_PATH, page: 'video' });
    expect(VIDEO_PATH).toBe('/app/video');
  });

  it('parses the Timeline page, which needs a cam-proxy', () => {
    expect(parseRoute('/app/timeline', '?cam=den').page).toBe('timeline');
    expect(NAV_ITEMS.find((i) => i.id === 'timeline')).toMatchObject({ href: '/app/timeline', page: 'timeline', needsProxy: true });
  });

  it('parses the Archive page, which needs a cam-proxy', () => {
    expect(parseRoute('/app/archive', '?item=den:12')).toMatchObject({ page: 'archive' });
    expect(NAV_ITEMS.find((i) => i.id === 'archive')).toMatchObject({ href: '/app/archive', page: 'archive', needsProxy: true, icon: 'archive' });
  });

  it('marks Video active in both modes and for the old URLs', () => {
    for (const [p, s] of [['/app/video', ''], ['/app/video', '?at=1'], ['/app/live', ''], ['/app/recordings', '?panel=events']]) {
      expect(NAV_ITEMS.filter((i) => isActive(i, parseRoute(p, s))).map((i) => i.id)).toEqual(['video']);
    }
    expect(NAV_ITEMS.filter((i) => isActive(i, parseRoute('/app/about', ''))).map((i) => i.id)).toEqual(['about']);
  });
});
