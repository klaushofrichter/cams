// The Archive's shared rules (cam-proxy's archive contract §1 and §3).
import { describe, expect, it } from 'vitest';
import { compareItems, labelProblem, nameProblem, normalizeLabels, preselectLabels, retentionProblem, sortItems, type Sortable } from '../server/archiveRules';

describe('labels', () => {
  it('takes one word of letters and digits, up to 24', () => {
    expect(labelProblem('Fox')).toBeNull();
    expect(labelProblem('a1B2')).toBeNull();
    expect(labelProblem('')).toMatch(/at least one/);
    expect(labelProblem('two words')).toMatch(/one word/);
    expect(labelProblem('fox-1')).toMatch(/one word/);
    expect(labelProblem('Füchse')).toMatch(/one word/);
    expect(labelProblem('x'.repeat(25))).toMatch(/at most 24/);
  });

  it('is a case-insensitive set: the first spelling wins, the predefined keep theirs', () => {
    expect(normalizeLabels(['pet', 'Fox', 'FOX', '4k', 'sd', 'person'])).toEqual({ ok: true, labels: ['Pet', 'Fox', '4K', 'SD', 'Person'] });
    expect(normalizeLabels([])).toEqual({ ok: true, labels: [] });
  });

  it('refuses more than 16, a bad one, and anything that is not a list of strings', () => {
    expect(normalizeLabels(Array.from({ length: 17 }, (_, i) => `l${i}`))).toEqual({ ok: false, error: 'At most 16 labels.' });
    expect(normalizeLabels(Array.from({ length: 17 }, () => 'same'))).toEqual({ ok: true, labels: ['same'] });
    expect(normalizeLabels(['ok', 'not ok']).ok).toBe(false);
    expect(normalizeLabels('Pet').ok).toBe(false);
    expect(normalizeLabels([1]).ok).toBe(false);
  });

  it('preselects the clip’s person, vehicle and pet kinds and SD or 4K by its size', () => {
    expect(preselectLabels(['motion', 'person', 'pet'], 'sd')).toEqual(['Person', 'Pet', 'SD']);
    expect(preselectLabels(['vehicle'], '4k')).toEqual(['Vehicle', '4K']);
    expect(preselectLabels(['motion'], '720p')).toEqual([]);
  });
});

describe('name and retention', () => {
  it('a name is 1 to 120 characters after trimming, without control characters', () => {
    expect(nameProblem('  Fox at the door ')).toBeNull();
    expect(nameProblem('   ')).toMatch(/empty/);
    expect(nameProblem('x'.repeat(121))).toMatch(/120/);
    expect(nameProblem(' ' + 'x'.repeat(120) + ' ')).toBeNull();
    expect(nameProblem('a\nb')).toMatch(/control/);
    expect(nameProblem(5)).toMatch(/text/);
  });

  it('retention is whole days 1 to 36500, or null for forever', () => {
    expect(retentionProblem(365)).toBeNull();
    expect(retentionProblem(null)).toBeNull();
    expect(retentionProblem(1)).toBeNull();
    expect(retentionProblem(36500)).toBeNull();
    for (const bad of [0, 36501, 1.5, '30', undefined]) expect(retentionProblem(bad)).not.toBeNull();
  });
});

const item = (id: number, o: Partial<Sortable> = {}): Sortable => ({ id, cam: 'cam1', name: `n${id}`, labels: [], createdAt: 1000 + id, expiresAt: 5000, recordedFrom: 100, durationS: 10, quality: 'sd', bytes: 1, ...o });
const ids = (xs: Sortable[]) => xs.map((x) => x.id);

describe('sort (contract §3)', () => {
  it('created descending by default', () => {
    expect(ids(sortItems([item(1), item(3), item(2)], 'created', 'desc'))).toEqual([3, 2, 1]);
    expect([item(1), item(3), item(2)].sort((a, b) => compareItems(a, b)).map((x) => x.id)).toEqual([3, 2, 1]);
  });

  it('ties go by recordedFrom descending, then id descending, in either order', () => {
    const xs = [item(1, { bytes: 5, recordedFrom: 10 }), item(2, { bytes: 5, recordedFrom: 30 }), item(3, { bytes: 5, recordedFrom: 30 })];
    expect(ids(sortItems(xs, 'size', 'asc'))).toEqual([3, 2, 1]);
    expect(ids(sortItems(xs, 'size', 'desc'))).toEqual([3, 2, 1]);
  });

  it('name is case-insensitive', () => {
    expect(ids(sortItems([item(1, { name: 'b' }), item(2, { name: 'A' }), item(3, { name: 'c' })], 'name', 'asc'))).toEqual([2, 1, 3]);
  });

  it('expires: forever is the latest (last ascending, first descending)', () => {
    const xs = [item(1, { expiresAt: 300 }), item(2, { expiresAt: null }), item(3, { expiresAt: 100 })];
    expect(ids(sortItems(xs, 'expires', 'asc'))).toEqual([3, 1, 2]);
    expect(ids(sortItems(xs, 'expires', 'desc'))).toEqual([2, 1, 3]);
  });

  it('quality by resolution: 360p < sd < 720p < 1080p < 4k', () => {
    const xs = ['4k', '720p', 'sd', '1080p', '360p'].map((q, i) => item(i + 1, { quality: q }));
    expect(sortItems(xs, 'quality', 'asc').map((x) => x.quality)).toEqual(['360p', 'sd', '720p', '1080p', '4k']);
  });

  it('labels: the first label alphabetically, items without labels last in both orders', () => {
    const xs = [item(1, { labels: ['Vehicle', 'Bird'] }), item(2, { labels: [] }), item(3, { labels: ['person'] }), item(4, { labels: ['Cat'] })];
    expect(ids(sortItems(xs, 'labels', 'asc'))).toEqual([1, 4, 3, 2]);
    expect(ids(sortItems(xs, 'labels', 'desc'))).toEqual([3, 4, 1, 2]);
  });

  it('camera, duration and recorded', () => {
    expect(ids(sortItems([item(1, { cam: 'cam2' }), item(2, { cam: 'cam1' })], 'cam', 'asc'))).toEqual([2, 1]);
    expect(ids(sortItems([item(1, { durationS: 9.5 }), item(2, { durationS: 30 })], 'duration', 'desc'))).toEqual([2, 1]);
    expect(ids(sortItems([item(1, { recordedFrom: 9 }), item(2, { recordedFrom: 3 })], 'recorded', 'asc'))).toEqual([2, 1]);
  });

  it('merged across proxies, equal ids are told apart by the proxy', () => {
    const a = { ...item(1), via: 'den' }, b = { ...item(1), via: 'cam2' };
    expect(sortItems([a, b], 'created', 'desc').map((x) => x.via)).toEqual(['cam2', 'den']);
  });
});
