import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, isActive, parseRoute } from './router';

describe('parseRoute', () => {
  it.each([
    ['/app/live', '', 'video'],
    ['/app/recordings', '', 'video'],
    ['/app/settings', '', 'settings'],
    ['/app/about', '', 'about'],
    ['/app', '', 'video'],
    ['/app/', '', 'video'],
    // Review focus 5: unknown pages fall back to Live, never a blank shell.
    ['/app/nope', '', 'video'],
    ['/app/recordings/extra', '', 'video'],
  ])('%s -> %s', (path, search, page) => {
    expect(parseRoute(path, search).page).toBe(page);
  });

  it('reads the recordings panel, defaulting to history', () => {
    expect(parseRoute('/app/recordings', '?panel=events').panel).toBe('history'); // Events is History now (Klaus, 2026-09-28)
    expect(parseRoute('/app/recordings', '?panel=downloads').panel).toBe('history'); // Downloads is part of History now (Klaus, 2026-09-29)
    expect(parseRoute('/app/recordings', '?panel=bogus').panel).toBe('history');
    expect(parseRoute('/app/recordings', '').panel).toBe('history');
  });

  it('routes Live and the recordings panels to one video page (spec 2026-09-28)', () => {
    expect(parseRoute('/app/live', '')).toMatchObject({ page: 'video', panel: 'live' });
    expect(parseRoute('/app/recordings', '?panel=downloads')).toMatchObject({ page: 'video', panel: 'history' });
    expect(parseRoute('/app/recordings', '?panel=events')).toMatchObject({ page: 'video', panel: 'history' });
    expect(parseRoute('/app/recordings', '')).toMatchObject({ page: 'video', panel: 'history' });
    expect(parseRoute('/app/nope', '')).toMatchObject({ page: 'video', panel: 'live' });
    expect(parseRoute('/app/live', '?panel=downloads').panel).toBe('live');
  });

  it('keeps other query params for later plans', () => {
    expect(parseRoute('/app/recordings', '?cam=cam1&t=x').params.get('cam')).toBe('cam1');
  });
});

describe('navigation items', () => {
  it('lists the menu entries in order', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Live', 'History', 'Timeline', 'Settings', 'About']);
  });

  it('parses the Timeline page, which needs a cam-proxy', () => {
    expect(parseRoute('/app/timeline', '?cam=den').page).toBe('timeline');
    expect(NAV_ITEMS.find((i) => i.id === 'timeline')).toMatchObject({ href: '/app/timeline', page: 'timeline', needsProxy: true });
  });

  it('points History at the recordings workspace', () => {
    const hrefs = Object.fromEntries(NAV_ITEMS.map((i) => [i.id, i.href]));
    expect(hrefs.history).toBe('/app/recordings?panel=history');
    expect(hrefs.downloads).toBeUndefined();
  });

  it('marks exactly one item active', () => {
    const r = parseRoute('/app/recordings', '?panel=events');
    expect(NAV_ITEMS.filter((i) => isActive(i, r)).map((i) => i.id)).toEqual(['history']);
    const live = parseRoute('/app/live', '');
    expect(NAV_ITEMS.filter((i) => isActive(i, live)).map((i) => i.id)).toEqual(['live']);
  });
});
