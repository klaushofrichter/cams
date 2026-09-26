import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DiskCache } from '../server/recordings/cache';

const dir = () => mkdtempSync(join(tmpdir(), 'cams-cache-'));
const bytes = (n: number) => async (tmp: string) => writeFileSync(tmp, Buffer.alloc(n, 1));

describe('DiskCache', () => {
  it('fills once and serves from disk afterwards', async () => {
    const cache = new DiskCache(dir(), 10_000);
    let calls = 0;
    const p = await cache.fill('a.mp4', async (tmp) => { calls++; writeFileSync(tmp, 'x'); });
    await cache.fill('a.mp4', async () => { calls++; });
    expect(calls).toBe(1);
    expect(statSync(p).size).toBe(1);
  });

  // Review focus 2: concurrent requests share one fetch.
  it('shares one producer between concurrent fills of the same key', async () => {
    const cache = new DiskCache(dir(), 10_000);
    let calls = 0;
    const producer = async (tmp: string) => { calls++; await new Promise((r) => setTimeout(r, 30)); writeFileSync(tmp, 'x'); };
    await Promise.all([cache.fill('k', producer), cache.fill('k', producer), cache.fill('k', producer)]);
    expect(calls).toBe(1);
  });

  // Review focus 2: a failed fetch leaves nothing behind.
  it('leaves no file (and no temp file) when the producer fails', async () => {
    const d = dir();
    const cache = new DiskCache(d, 10_000);
    await expect(cache.fill('bad', async (tmp) => { writeFileSync(tmp, 'partial'); throw new Error('camera gone'); })).rejects.toThrow('camera gone');
    expect(await cache.has('bad')).toBe(false);
    expect(readdirSync(d)).toEqual([]);
    // a later fill retries
    await cache.fill('bad', bytes(3));
    expect(await cache.has('bad')).toBe(true);
  });

  // Review focus 4: stays under the cap, oldest first, never a pinned file.
  it('evicts least recently used files to stay under the cap, skipping pinned ones', async () => {
    const d = dir();
    const cache = new DiskCache(d, 250);
    await cache.fill('old', bytes(100));
    await new Promise((r) => setTimeout(r, 15));
    await cache.fill('pinned', bytes(100));
    cache.pin('pinned');
    await new Promise((r) => setTimeout(r, 15));
    await cache.fill('new', bytes(100));
    expect(await cache.has('old')).toBe(false);
    expect(await cache.has('pinned')).toBe(true);
    expect(await cache.has('new')).toBe(true);
    cache.unpin('pinned');
  });

  it('rejects keys that could escape the cache directory', () => {
    const cache = new DiskCache(dir(), 100);
    for (const key of ['../x', 'a/b', '', '.hidden']) expect(() => cache.path(key)).toThrow();
  });
});
