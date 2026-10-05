import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Klaus 2026-10-05: Chromium put its Cast button on our players when a cast
// device was on the LAN. Casting can't work (live is assembled in the browser,
// recordings need the cams login), so every <video> opts out of it.
function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? svelteFiles(p) : p.endsWith('.svelte') ? [p] : [];
  });
}

describe('video elements', () => {
  it('all set disableremoteplayback, so the browser shows no Cast button', () => {
    const missing: string[] = [];
    for (const file of svelteFiles(join(__dirname, '..', 'web', 'src'))) {
      // Comments mention <video> too; only real tags count.
      const code = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(\/\/|\*).*$/gm, '');
      for (const tag of code.match(/<video\b[^>]*>/g) ?? []) {
        if (!/\bdisableremoteplayback\b/.test(tag)) missing.push(`${file.split('/web/src/')[1]}: ${tag.slice(0, 60)}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
