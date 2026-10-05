// web/src/pages/Archive.svelte.test.ts
// @vitest-environment jsdom
// The Archive page (cams spec 2026-10-05-archive-design): the merged list,
// sorting, filters, selection, bulk actions with confirmation, edit, player.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Archive from './Archive.svelte';
import { cameras } from '../lib/stores';
import type { ArchiveItem } from '../lib/archive';

const T = Date.parse('2026-10-05T14:00:00-05:00');
const DAY = 86_400_000;
const item = (via: string, id: number, o: Partial<ArchiveItem> = {}): ArchiveItem => {
  const base = `/api/archive/${via}/items/${id}`;
  return {
    via, id, cam: 'cam1', camera: via, cameraName: via === 'den' ? 'Den' : 'Cam 2', name: `clip ${via} ${id}`, labels: [], retentionDays: 365, createdAt: T + id * 1000, expiresAt: T + id * 1000 + 365 * DAY,
    recordedFrom: T - id * 60_000, recordedTo: T - id * 60_000 + 30_000, durationS: 30, quality: 'sd', original: false, bytes: 1_000_000 * id, source: { type: 'composition', size: 'sd', preS: 0, postS: 5 },
    eventKinds: [], found: [], thumbnail: { from: 'frame', at: null }, createdBy: 'client', urls: { video: `${base}/video`, download: `${base}/video?download=1`, thumbnail: `${base}/thumbnail`, metadata: `${base}/metadata` }, ...o,
  };
};
let items: ArchiveItem[] = [];
let calls: { url: string; method: string; body: unknown }[] = [];
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;

beforeEach(() => {
  calls = [];
  items = [
    item('den', 1, { labels: ['Person', 'SD'], name: 'Fox at the door' }),
    item('den', 2, { labels: ['Pet'], bytes: 9_000_000, expiresAt: null, retentionDays: null }),
    item('cam2', 1, { labels: ['Pet', 'Owl'], recordedFrom: T - 30 * DAY, bytes: 2_000_000 }),
  ];
  cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true }, { id: 'cam2', name: 'Cam 2', webUiUrl: null, proxy: true }]);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const json = (b: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(b), { status });
    if (url.startsWith('/api/archive?')) return json({ total: items.length, items, proxies: [{ via: 'den', cams: ['den'], ok: true }, { via: 'cam2', cams: ['cam2'], ok: true }, { via: 'silo', cams: ['silo'], ok: false, error: 'too_old' }] });
    if (url === '/api/archive/status') return json([{ via: 'den', ok: true, count: 2, bytes: 10_000_000, percentOfDisk: 0.4, warning: false, disk: { free: 98_000_000_000 } }]);
    if (url.endsWith('/extent')) return json({ oldest: T - 7 * DAY });
    const del = /^\/api\/archive\/(\w+)\/delete$/.exec(url);
    if (del) return json({ deleted: (body as { ids: number[] }).ids, notFound: [] });
    const one = /^\/api\/archive\/(\w+)\/items\/(\d+)$/.exec(url);
    if (one && method === 'PATCH') {
      const x = items.find((i) => i.via === one[1] && i.id === Number(one[2]))!;
      return json({ ...x, ...(body as object) });
    }
    if (url.endsWith('/metadata')) return json({ item: items[0], camera: { id: 'cam1', name: 'Den', model: null }, window: { from: 0, to: 1 }, events: [{ id: 5, kind: 'person', source: 'onvif', start: T, end: T + 5000, recovered: false, analysis: { provider: 'google-vision', status: 'ok', stillTs: T + 1000, objects: [{ name: 'Person', score: 0.91 }], summary: [{ category: 'person', score: 0.84 }] } }], stillChecks: [], proxy: { version: '1' }, archivedAt: T });
    return json({ error: 'not_found' }, 404);
  }));
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
  cameras.set([]);
});

async function render() {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(Archive, { target });
  flushSync();
  await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
}
const q = (id: string, root: ParentNode = document) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const all = (id: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const rows = () => all('archive-row');
const names = () => rows().map((r) => q('archive-name-cell', r)!.textContent);
const click = (el: HTMLElement | null, init: MouseEventInit = {}) => {
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  flushSync();
};

describe('Archive page', () => {
  it('lists every proxy’s clips, newest archived first, and says which proxy has none', async () => {
    await render();
    expect(names()).toEqual(['clip den 2', 'Fox at the door', 'clip cam2 1']);
    expect(q('archive-summary')!.textContent).toContain('3 clips · 12.0 MB');
    expect(q('archive-proxy-note')!.textContent).toBe('silo’s cam-proxy has no Archive yet (an older version).');
    expect(all('archive-expires').map((e) => e.textContent)).toEqual(['forever', expect.stringMatching(/^in 36[45] days$/), expect.stringMatching(/^in 36[45] days$/)]);
  });

  it('sorts by a column (asking the proxies in that order), and back the other way', async () => {
    await render();
    click(q('archive-sort-size'));
    expect(names()).toEqual(['clip den 2', 'clip cam2 1', 'Fox at the door']);
    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/archive?sort=size&order=desc')).toBe(true));
    click(q('archive-sort-size'));
    expect(names()).toEqual(['Fox at the door', 'clip cam2 1', 'clip den 2']);
    expect(q('archive-sort-size')!.closest('th')!.getAttribute('aria-sort')).toBe('ascending');
    click(q('archive-sort-name'));
    expect(names()).toEqual(['clip cam2 1', 'clip den 2', 'Fox at the door']);
  });

  it('filters by label chips (all of them), camera and text', async () => {
    await render();
    click(document.querySelector('[data-testid="archive-filter-label"][data-label="Pet"]'));
    expect(names()).toEqual(['clip den 2', 'clip cam2 1']);
    click(document.querySelector('[data-testid="archive-filter-label"][data-label="Owl"]'));
    expect(names()).toEqual(['clip cam2 1']);
    click(document.querySelector('[data-testid="archive-filter-label"][data-label="Owl"]'));
    const cam = q('archive-camera') as HTMLSelectElement;
    cam.value = 'den';
    cam.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(names()).toEqual(['clip den 2']);
    click(document.querySelector('[data-testid="archive-filter-label"][data-label="Pet"]'));
    const search = q('archive-search') as HTMLInputElement;
    search.value = 'door';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(names()).toEqual(['Fox at the door']);
  });

  it('links the recorded time to the Video page only while the camera holds the recording', async () => {
    await render();
    const rec = all('archive-recorded');
    expect(rec[0].tagName).toBe('A');
    expect(rec[0].getAttribute('href')).toBe(`/app/video?cam=den&date=2026-10-05&at=${T - 120_000}`);
    await vi.waitFor(() => expect(all('archive-recorded')[2].tagName).toBe('SPAN')); // 30 days back, the camera keeps 7
    expect(all('archive-recorded')[2].getAttribute('title')).toMatch(/no longer holds/);
  });

  it('selects one, a shift-click range, all shown and none', async () => {
    await render();
    const boxes = () => all('archive-select') as HTMLInputElement[];
    click(boxes()[0]);
    expect(q('archive-selected-count')!.textContent).toBe('1 selected');
    click(boxes()[2], { shiftKey: true });
    expect(q('archive-selected-count')!.textContent).toBe('3 selected');
    click(boxes()[1]);
    expect(q('archive-selected-count')!.textContent).toBe('2 selected');
    expect((q('archive-select-all') as HTMLInputElement).indeterminate).toBe(true);
    click(q('archive-select-all'));
    expect(q('archive-selected-count')!.textContent).toBe('3 selected');
    click(q('archive-select-all'));
    expect(q('archive-bulk')).toBeNull();
  });

  it('deletes the selection after a confirmation naming the count, one request per proxy', async () => {
    await render();
    click(all('archive-select')[1]);
    click(all('archive-select')[2], { shiftKey: true });
    click(q('archive-bulk-delete'));
    expect(q('archive-confirm')!.getAttribute('aria-label')).toBe('Delete 2 clips?');
    expect(q('archive-confirm-delete')!.textContent).toBe('Delete 2 clips');
    click(q('archive-confirm-cancel'));
    expect(q('archive-confirm')).toBeNull();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    click(q('archive-bulk-delete'));
    click(q('archive-confirm-delete'));
    await vi.waitFor(() => expect(names()).toEqual(['clip den 2']));
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([['/api/archive/den/delete', { ids: [1] }], ['/api/archive/cam2/delete', { ids: [1] }]]);
    expect(q('archive-notice')!.textContent).toBe('Deleted 2 clips.');
  });

  it('downloads a ZIP per proxy for a selection across proxies', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const anchors: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this.getAttribute('href')!);
    });
    try {
      await render();
      click(q('archive-select-all'));
      click(q('archive-bulk-zip'));
      vi.advanceTimersByTime(2000);
      expect(anchors).toEqual(['/api/archive/den/zip?ids=1,2', '/api/archive/cam2/zip?ids=1']);
      expect(q('archive-notice')!.textContent).toBe('2 ZIP files: one per cam-proxy and 200 clips.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('edits one clip: only what changed is sent', async () => {
    await render();
    click(all('archive-edit')[1]); // Fox at the door
    const name = q('archive-edit-name') as HTMLInputElement;
    expect(name.value).toBe('Fox at the door');
    name.value = 'Fox at night';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    click(q('archive-edit-save'));
    await vi.waitFor(() => expect(names()).toContain('Fox at night'));
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body])).toEqual([['/api/archive/den/items/1', { name: 'Fox at night' }]]);
    expect(q('archive-edit-dialog')).toBeNull();
  });

  it('sets labels on many: on for all, off for all, the mixed ones kept per clip', async () => {
    await render();
    click(all('archive-select')[0]); // den 2: Pet
    click(all('archive-select')[2], { shiftKey: true }); // and Fox (Person, SD), cam2 1 (Pet, Owl)
    click(q('archive-bulk-labels'));
    const dialog = q('archive-edit-dialog')!;
    const chip = (l: string) => dialog.querySelector(`[data-label="${l}"]`) as HTMLElement;
    expect(chip('Pet').getAttribute('aria-pressed')).toBe('mixed');
    click(chip('Pet').querySelector('button') ?? chip('Pet')); // → on for all
    click(chip('Vehicle'));
    click(dialog.querySelector('[data-label="Owl"] [data-testid="label-remove"]'));
    click(q('archive-edit-save'));
    await vi.waitFor(() => expect(q('archive-edit-dialog')).toBeNull());
    const patches = calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body]);
    expect(patches).toEqual(expect.arrayContaining([
      ['/api/archive/den/items/2', { labels: ['Pet', 'Vehicle'] }],
      ['/api/archive/den/items/1', { labels: ['Person', 'SD', 'Pet', 'Vehicle'] }],
      ['/api/archive/cam2/items/1', { labels: ['Pet', 'Vehicle'] }],
    ]));
    expect(patches).toHaveLength(3);
  });

  it('opens the player from a thumbnail: the video through cams, the controls, the events', async () => {
    await render();
    click(all('archive-thumb')[1]);
    const player = q('archive-player')!;
    expect((q('archive-video', player) as HTMLVideoElement).getAttribute('src')).toBe('/api/archive/den/items/1/video');
    expect(q('archive-download', player)!.getAttribute('href')).toBe('/api/archive/den/items/1/video?download=1');
    expect(q('archive-source', player)!.textContent).toBe('Composed: SD, pre-roll 0 s, post-roll 5 s');
    await vi.waitFor(() => expect(q('archive-events', player)).not.toBeNull());
    expect(q('archive-events', player)!.textContent).toContain('✦ Vision: Person 84%');
    expect(q('archive-events', player)!.textContent).toContain('Objects: Person 91%');
    const video = q('archive-video', player) as HTMLVideoElement;
    Object.defineProperty(video, 'duration', { configurable: true, value: 30 });
    video.dispatchEvent(new Event('loadedmetadata'));
    click(q('archive-fwd10', player));
    expect(video.currentTime).toBe(10);
    click(q('archive-back1', player));
    expect(video.currentTime).toBe(9);
    click(q('archive-back10', player));
    expect(video.currentTime).toBe(0);
    click(q('archive-player-close'));
    expect(q('archive-player')).toBeNull();
  });

  it('reloads on the relayed archive message', async () => {
    const sources: { listeners: Map<string, (e: { data: string }) => void> }[] = [];
    vi.stubGlobal('EventSource', class {
      readyState = 1;
      onopen = null;
      onerror = null;
      listeners = new Map<string, (e: { data: string }) => void>();
      constructor() {
        sources.push(this);
      }
      addEventListener(t: string, fn: (e: { data: string }) => void) {
        this.listeners.set(t, fn);
      }
      close() {}
    });
    await render();
    const lists = () => calls.filter((c) => c.url.startsWith('/api/archive?')).length;
    expect(lists()).toBe(1);
    items = [...items, item('cam2', 7, { name: 'From elsewhere', createdAt: T + 99_000 })];
    sources[0].listeners.get('archive')!({ data: JSON.stringify({ cam: 'cam2', action: 'add', ids: [7] }) });
    await vi.waitFor(() => expect(names()[0]).toBe('From elsewhere'));
    expect(lists()).toBe(2);
  });

  it('shows cards on a phone', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('767'), addEventListener() {}, removeEventListener() {} }));
    await render();
    expect(q('archive-list')!.tagName).toBe('UL');
    expect(q('archive-sort')).not.toBeNull();
  });
});
