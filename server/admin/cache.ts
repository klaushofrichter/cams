// The config cache (M §9.4): the last applied snapshot, verbatim with its
// signature, in <data>/admin/config-cache.json (600). Verified at every
// start against the pinned server keys; a cache that fails is ignored
// (config_cache_untrusted), never trusted and never a crash.
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger';
import { adminDir, dataDir, writePrivate, type AdminKeyFile } from './keyfile';
import { verifySnapshot, type Snapshot } from './snapshot';

export const cacheFile = (dir: string = dataDir()) => join(adminDir(dir), 'config-cache.json');

export function readCache(k: Pick<AdminKeyFile, 'serverKeys' | 'instanceId'>, dir: string = dataDir()): Snapshot | null {
  let text: string;
  try {
    text = readFileSync(cacheFile(dir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ reason: 'unreadable' }, 'config_cache_untrusted');
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    logger.warn({ reason: 'shape' }, 'config_cache_untrusted');
    return null;
  }
  const v = verifySnapshot(raw, k.serverKeys, k.instanceId);
  if (!v.ok) {
    logger.warn({ reason: v.reason }, 'config_cache_untrusted');
    return null;
  }
  return v.snapshot;
}

// When the cache was last written (the last successful pull before a restart).
export function cacheWrittenAt(dir: string = dataDir()): number | null {
  try {
    return statSync(cacheFile(dir)).mtimeMs;
  } catch {
    return null;
  }
}

export function writeCache(s: Snapshot, dir: string = dataDir()): void {
  writePrivate(cacheFile(dir), JSON.stringify(s));
}
