import { promises as fs } from 'fs';
import { join } from 'path';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A flat directory of rebuildable files (clips, thumbnails) with a byte cap.
// Files are produced into a temp name and renamed, so readers never see a
// partial file; concurrent fills of one key share a single producer; the
// least recently used unpinned files go first when over the cap.
export class DiskCache {
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly pins = new Map<string, number>();
  private ready: Promise<void> | null = null;

  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {}

  path(key: string): string {
    if (!KEY.test(key) || key.includes('..')) throw new Error(`invalid cache key: ${key}`);
    return join(this.dir, key);
  }

  // A stray *.tmp-* file can only be a leftover from a process that crashed
  // mid-fill: every in-flight fill of this process starts after ensureDir()
  // and cleans up its own temp file on success or failure, so any tmp file
  // seen here predates this process entirely. This sweep assumes one process
  // owns this cache directory at a time (true in production: a single pod
  // per cache volume); a second process sharing the same dir concurrently
  // could have its own in-progress tmp file swept here.
  private ensureDir(): Promise<void> {
    this.ready ??= (async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const names = await fs.readdir(this.dir).catch(() => []);
      await Promise.all(
        // A single bad entry (permissions, a concurrent unlink, ...) must
        // not poison `ready` and leave every future fill() rejecting.
        names.filter((n) => n.includes('.tmp-')).map((n) => fs.rm(join(this.dir, n), { force: true }).catch(() => {})),
      );
    })();
    return this.ready;
  }

  async has(key: string): Promise<boolean> {
    try {
      await fs.access(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async touch(key: string): Promise<void> {
    const now = new Date();
    await fs.utimes(this.path(key), now, now).catch(() => {});
  }

  pin(key: string): void {
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
  }

  unpin(key: string): void {
    const n = (this.pins.get(key) ?? 1) - 1;
    if (n <= 0) this.pins.delete(key);
    else this.pins.set(key, n);
  }

  fill(key: string, producer: (tmpPath: string) => Promise<void>): Promise<string> {
    const target = this.path(key);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const work = (async () => {
      await this.ensureDir();
      if (await this.has(key)) {
        await this.touch(key);
        return target;
      }
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      try {
        await producer(tmp);
        await fs.rename(tmp, target);
      } catch (err) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      await this.evict(key);
      return target;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async evict(justAdded: string): Promise<void> {
    const names = (await fs.readdir(this.dir)).filter((n) => !n.includes('.tmp-'));
    const files = await Promise.all(
      names.map(async (name) => {
        const s = await fs.stat(join(this.dir, name)).catch(() => null);
        return s ? { name, size: s.size, mtime: s.mtimeMs } : null;
      }),
    );
    const live = files.filter((f): f is { name: string; size: number; mtime: number } => f !== null);
    let total = live.reduce((sum, f) => sum + f.size, 0);
    for (const f of live.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= this.maxBytes) break;
      if (f.name === justAdded || this.pins.has(f.name)) continue;
      await fs.rm(join(this.dir, f.name), { force: true });
      total -= f.size;
    }
  }
}
