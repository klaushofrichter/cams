import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DiskCache } from '../server/recordings/cache';

// Fix round 1, item 11: clean up this file's own mkdtemp dirs rather than
// leaving them under the system tmpdir forever.
const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'cams-cache-'));
  dirs.push(d);
  return d;
};
const bytes = (n: number) => async (tmp: string) => writeFileSync(tmp, Buffer.alloc(n, 1));

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

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

  // Fix round 1, item 4: pinned before fill() is even called, so there is
  // never a window (between fill() resolving and the caller pinning it)
  // where a concurrent evict() could remove the file.
  it('never evicts a key that was pinned before its fill started', async () => {
    const d = dir();
    const cache = new DiskCache(d, 250); // room for two 100-byte files, not three
    cache.pin('a');
    await cache.fill('a', bytes(100));
    await new Promise((r) => setTimeout(r, 15));
    await cache.fill('b', bytes(100));
    await new Promise((r) => setTimeout(r, 15));
    // Forces an eviction pass with all three present: 'a' is the oldest but
    // pinned, so 'b' (the next-oldest, unpinned) must be evicted instead.
    await cache.fill('c', bytes(100));
    expect(await cache.has('a')).toBe(true);
    expect(await cache.has('b')).toBe(false);
    expect(await cache.has('c')).toBe(true);
    cache.unpin('a');
  });

  // M7: a transient failure of ensureDir()'s mkdir (e.g. the cache volume
  // isn't mounted yet) must not wedge the memoised `ready` promise into a
  // permanent rejection; the next fill() should retry from scratch.
  it('retries ensureDir after a failure instead of failing every fill forever', async () => {
    const d = dir();
    const blocker = join(d, 'blocked'); // a file, not a directory
    writeFileSync(blocker, 'not a directory');
    const cache = new DiskCache(join(blocker, 'cache'), 10_000);
    await expect(cache.fill('a', bytes(3))).rejects.toThrow();
    rmSync(blocker, { force: true }); // clears the way for mkdir to succeed
    await cache.fill('a', bytes(3));
    expect(await cache.has('a')).toBe(true);
  });

  // Fix round 1, item 7: a *.tmp-* file can only be left behind by a
  // process that crashed mid-fill; the next process to use this directory
  // clears it out on first use.
  it('removes orphaned .tmp- files left behind by a previous process', async () => {
    const d = dir();
    writeFileSync(join(d, 'stale.mp4.tmp-999-123456'), 'leftover');
    const cache = new DiskCache(d, 10_000);
    await cache.fill('a', bytes(3));
    expect(readdirSync(d).sort()).toEqual(['a']);
  });
});
