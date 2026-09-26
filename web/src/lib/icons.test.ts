import { describe, expect, it } from 'vitest';
import { ICONS } from './icons';

// Walks every .svelte file under web/src (via Vite's glob import, so no
// Node fs/path APIs are needed -- those aren't typed under web/tsconfig.json,
// which is browser-only) for <Icon name="…"> usages, and asserts each name
// is a real key of ICONS. svelte-check can't be used here (TS7 unsupported)
// and `npm run check` doesn't see .svelte files, so this test is the guard
// against a typo'd or missing icon silently rendering an empty box -- as
// happened with `external`/`power`.
const files = import.meta.glob('../**/*.svelte', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('Icon usages', () => {
  it('every <Icon name="…"> refers to a key of ICONS', () => {
    const used = new Set<string>();
    for (const text of Object.values(files)) {
      for (const m of text.matchAll(/<Icon\s[^>]*\bname=["']([^"'{}]+)["']/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used].filter((n) => !(n in ICONS));
    expect(missing).toEqual([]);
  });
});
