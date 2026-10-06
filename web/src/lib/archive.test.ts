import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyLabelStates, clickSelect, createArchive, defaultName, deleteItems, errorText, expiresText, zipDelays, filterItems, formatBytes, headerState, labelChoices, labelStates, stillRecorded, toggleAll, videoHref, zipUrls, type ArchiveItem } from './archive';

afterEach(() => vi.unstubAllGlobals());

const item = (via: string, id: number, o: Partial<ArchiveItem> = {}): ArchiveItem => ({
  via, id, cam: 'cam1', camera: via, cameraName: 'Den', name: `clip ${id}`, labels: [], retentionDays: 365, createdAt: 0, expiresAt: null, recordedFrom: 0, recordedTo: 0, durationS: 10, quality: 'sd', original: false, bytes: 1, source: {}, eventKinds: [], found: [], thumbnail: { from: 'frame', at: null }, createdBy: 'client',
  urls: { video: '', download: '', thumbnail: null, metadata: '' }, ...o,
});
const DAY = 86_400_000;

describe('words', () => {
  it('the default name is the recording’s start in the viewer’s clock and the camera’s name (TZ America/Chicago)', () => {
    expect(defaultName(Date.parse('2026-10-05T14:03:22-05:00'), 'Den')).toBe('2026-10-05 14:03:22 Den');
    expect(defaultName(Date.parse('2026-01-02T03:04:05-06:00'), 'Back yard')).toBe('2026-01-02 03:04:05 Back yard');
  });

  it('says when a clip expires', () => {
    const now = 1_000_000_000_000;
    expect(expiresText(null, now)).toBe('forever');
    expect(expiresText(now + 120 * DAY + 5, now)).toBe('in 120 days');
    expect(expiresText(now + DAY + 5, now)).toBe('in 1 day');
    expect(expiresText(now + 3_600_000, now)).toBe('today');
    expect(expiresText(now - 1, now)).toBe('expired');
  });

  it('formats sizes in decimal units', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(4_123_456)).toBe('4.1 MB');
    expect(formatBytes(2_147_483_648)).toBe('2.1 GB');
  });

  it('says insufficient space with the sizes, and the other refusals in words', () => {
    expect(errorText('insufficient_space', { needed: 300_000_000, free: 2_100_000_000, minFreeBytes: 2_147_483_648 })).toBe('Not enough space on the cam-proxy: the clip needs 300.0 MB, 2.1 GB is free, and 2.1 GB must stay free.');
    expect(errorText('insufficient_space', { detail: 'disk full' })).toBe('Not enough space on the cam-proxy for this clip (disk full).');
    expect(errorText('fetch_failed')).toMatch(/couldn’t fetch/);
    expect(errorText('archive_off')).toMatch(/switched off/);
    expect(errorText('invalid', { detail: 'At most 16 labels.' })).toBe('At most 16 labels.');
    expect(errorText('mystery')).toBe('The clip could not be archived.');
  });
});

describe('the API', () => {
  it('creates, and turns a refusal into readable words', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'insufficient_space', needed: 2_000_000, free: 1_000_000, minFreeBytes: 500_000 }), { status: 507 }));
    vi.stubGlobal('fetch', fetch);
    await expect(createArchive('den', { source: { type: 'composition', id: 'x'.repeat(22) }, labels: ['Pet'], retentionDays: 365 })).rejects.toThrow('the clip needs 2.0 MB, 1.0 MB is free, and 500.0 kB must stay free');
    expect(fetch).toHaveBeenCalledWith('/api/cameras/den/archive', expect.objectContaining({ method: 'POST', body: JSON.stringify({ source: { type: 'composition', id: 'x'.repeat(22) }, labels: ['Pet'], retentionDays: 365 }) }));
  });

  it('deletes per proxy, in pieces of 500, and counts gone ones as removed', async () => {
    const bodies: { url: string; ids: number[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const ids = (JSON.parse(String(init.body)) as { ids: number[] }).ids;
      bodies.push({ url, ids });
      return new Response(JSON.stringify({ deleted: ids.slice(1), notFound: ids.slice(0, 1) }), { status: 200 });
    }));
    const items = [...Array.from({ length: 501 }, (_, i) => item('den', i + 1)), item('cam2', 1)];
    const r = await deleteItems(items);
    // The proxies in parallel, each one's pieces in turn.
    const sizes = (url: string) => bodies.filter((x) => x.url === url).map((x) => x.ids.length);
    expect(bodies).toHaveLength(3);
    expect(sizes('/api/archive/den/delete')).toEqual([500, 1]);
    expect(sizes('/api/archive/cam2/delete')).toEqual([1]);
    expect(r.removed).toHaveLength(502);
    expect(r.errors).toEqual([]);
  });

  it('spaces ZIP downloads to 4 a minute, counting the ones started before', () => {
    const now = 1_000_000;
    expect(zipDelays([], 3, now)).toEqual([0, 0, 0]);
    expect(zipDelays([now - 70_000, now - 50_000, now - 10_000], 3, now)).toEqual([0, 0, 10_000 + 1000]); // now-70 s is out of the window
    expect(zipDelays([], 6, now)).toEqual([0, 0, 0, 0, 61_000, 61_000]);
  });

  it('makes one ZIP per proxy and 200 clips', () => {
    const items = [...Array.from({ length: 201 }, (_, i) => item('den', i + 1)), item('cam2', 7)];
    const urls = zipUrls(items);
    expect(urls).toHaveLength(3);
    expect(urls[1]).toBe('/api/archive/den/zip?ids=201&cam=den');
    expect(urls[2]).toBe('/api/archive/cam2/zip?ids=7&cam=cam2');
  });

  // A multi-camera proxy names its ZIPs "all": cams names one after the
  // camera of its clips when they are all of one camera (the server checks it).
  it('names the camera of a ZIP whose clips are all of one camera', () => {
    const silo = item('silo', 1, { camera: 'silo' }), loft = item('silo', 2, { camera: 'loft' }), ghost = item('silo', 3, { camera: null });
    expect(zipUrls([loft])).toEqual(['/api/archive/silo/zip?ids=2&cam=loft']);
    expect(zipUrls([silo, loft])).toEqual(['/api/archive/silo/zip?ids=1,2']);
    expect(zipUrls([ghost])).toEqual(['/api/archive/silo/zip?ids=3']);
    expect(zipUrls([item('silo', 4, { camera: 'a&b' })])).toEqual(['/api/archive/silo/zip?ids=4&cam=a%26b']);
  });
});

describe('filters', () => {
  const items = [item('den', 1, { labels: ['Pet', 'Fox'], name: 'Fox at the door' }), item('den', 2, { labels: ['Person'], camera: 'barn', cameraName: 'Barn' }), item('cam2', 3, { labels: ['pet'], camera: null, cameraName: 'Ghost' })];
  it('by all chosen labels (any case), camera and text', () => {
    expect(filterItems(items, { labels: ['pet'], camera: '', text: '' }).map((x) => x.id)).toEqual([1, 3]);
    expect(filterItems(items, { labels: ['Pet', 'Fox'], camera: '', text: '' }).map((x) => x.id)).toEqual([1]);
    expect(filterItems(items, { labels: [], camera: 'barn', text: '' }).map((x) => x.id)).toEqual([2]);
    expect(filterItems(items, { labels: [], camera: '?Ghost', text: '' }).map((x) => x.id)).toEqual([3]);
    expect(filterItems(items, { labels: [], camera: '', text: 'DOOR' }).map((x) => x.id)).toEqual([1]);
    expect(filterItems(items, { labels: [], camera: '', text: 'barn' }).map((x) => x.id)).toEqual([2]);
  });
  it('offers the predefined labels, then the others by use', () => {
    expect(labelChoices([...items, item('den', 4, { labels: ['Owl', 'Fox'] })], ['Pet', 'Person'])).toEqual(['Pet', 'Person', 'Fox', 'Owl']);
  });
});

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  it('a click toggles one; shift-click sets the range to the clicked row’s new state', () => {
    let s = clickSelect(new Set(), order, 'b', false, null);
    expect([...s]).toEqual(['b']);
    s = clickSelect(s, order, 'e', true, 'b');
    expect([...s].sort()).toEqual(['b', 'c', 'd', 'e']);
    s = clickSelect(s, order, 'c', true, 'e'); // c was on: c..e off
    expect([...s].sort()).toEqual(['b']);
    s = clickSelect(s, order, 'd', true, 'zz'); // an anchor no longer shown: just the one
    expect([...s].sort()).toEqual(['b', 'd']);
  });
  it('the header box: all, none or some of the shown rows; its click selects all shown, or none when all were', () => {
    expect(headerState(new Set(), order)).toBe('none');
    expect(headerState(new Set(['a']), order)).toBe('some');
    expect(headerState(new Set(order), order)).toBe('all');
    expect([...toggleAll(new Set(['a', 'x']), order)].sort()).toEqual([...order, 'x'].sort());
    expect([...toggleAll(new Set([...order, 'x']), order)]).toEqual(['x']); // rows not shown stay
  });
});

describe('Set labels on many clips', () => {
  const sel = [{ labels: ['Pet', 'Fox'] }, { labels: ['pet'] }];
  it('says per label: on for all, some or none', () => {
    expect([...labelStates(sel, ['Person'])]).toEqual([['Pet', 'all'], ['Fox', 'some'], ['Person', 'none']]);
  });
  it('a chip left at some keeps each clip’s own; all adds, none removes', () => {
    const st = new Map([['Pet', 'none'], ['Fox', 'some'], ['Person', 'all']] as const);
    expect(applyLabelStates(['Pet', 'Fox'], new Map(st))).toEqual(['Fox', 'Person']);
    expect(applyLabelStates(['pet'], new Map(st))).toEqual(['Person']);
  });
});

describe('links', () => {
  it('opens the Video page at the recording when the camera still holds it', () => {
    const it0 = item('den', 1, { camera: 'den', recordedFrom: Date.parse('2026-10-05T14:03:22-05:00') });
    expect(videoHref(it0)).toBe(`/app/video?cam=den&date=2026-10-05&at=${it0.recordedFrom}`);
    expect(videoHref({ ...it0, camera: null })).toBeNull();
    expect(stillRecorded(it0, it0.recordedFrom - 1)).toBe(true);
    expect(stillRecorded(it0, it0.recordedFrom + 1)).toBe(false);
    expect(stillRecorded(it0, null)).toBe(false);
  });
});
