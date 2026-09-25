import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, isActive, parseRoute } from './router';

describe('parseRoute', () => {
  it.each([
    ['/app/live', '', 'live'],
    ['/app/recordings', '', 'recordings'],
    ['/app/settings', '', 'settings'],
    ['/app/about', '', 'about'],
    ['/app', '', 'live'],
    ['/app/', '', 'live'],
    // Review focus 5: unknown pages fall back to Live, never a blank shell.
    ['/app/nope', '', 'live'],
    ['/app/recordings/extra', '', 'recordings'],
  ])('%s -> %s', (path, search, page) => {
    expect(parseRoute(path, search).page).toBe(page);
  });

  it('reads the recordings panel, defaulting to history', () => {
    expect(parseRoute('/app/recordings', '?panel=events').panel).toBe('events');
    expect(parseRoute('/app/recordings', '?panel=downloads').panel).toBe('downloads');
    expect(parseRoute('/app/recordings', '?panel=bogus').panel).toBe('history');
    expect(parseRoute('/app/recordings', '').panel).toBe('history');
  });

  it('keeps other query params for later plans', () => {
    expect(parseRoute('/app/recordings', '?cam=cam1&t=x').params.get('cam')).toBe('cam1');
  });
});

describe('navigation items', () => {
  it('lists the six menu entries in order', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Live', 'History', 'Events', 'Downloads', 'Settings', 'About']);
  });

  it('points History, Events and Downloads at the recordings workspace panels', () => {
    const hrefs = Object.fromEntries(NAV_ITEMS.map((i) => [i.id, i.href]));
    expect(hrefs.history).toBe('/app/recordings?panel=history');
    expect(hrefs.events).toBe('/app/recordings?panel=events');
    expect(hrefs.downloads).toBe('/app/recordings?panel=downloads');
  });

  it('marks exactly one item active', () => {
    const r = parseRoute('/app/recordings', '?panel=events');
    expect(NAV_ITEMS.filter((i) => isActive(i, r)).map((i) => i.id)).toEqual(['events']);
    const live = parseRoute('/app/live', '');
    expect(NAV_ITEMS.filter((i) => isActive(i, live)).map((i) => i.id)).toEqual(['live']);
  });
});
