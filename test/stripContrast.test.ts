import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// Klaus, 2026-10-04: the strip under the video was too light in dark mode,
// its motion clips hard to see. The dark tokens are darker, light mode is
// as before, and every clip mark keeps at least 3:1 against the bar, in
// its empty parts and over the stills (WCAG's ratio for graphics). Here,
// not next to the web code: it reads the stylesheet as a file.

const css = readFileSync(join(__dirname, '../web/src/styles/theme.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector}`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const dark = block(':root');
const light = block(":root[data-theme='light']");
const lightMedia = block('  :root:not([data-theme])');

type Rgb = [number, number, number];
const hex = (h: string): Rgb => {
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (!m) throw new Error(`not a #rrggbb colour: ${h}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255) as Rgb;
};
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: Rgb, b: Rgb) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
// A token's colour: #rrggbb, var(--x), or color-mix(in srgb, var(--x) N%, transparent) over a background.
function colour(tokens: Record<string, string>, value: string, over: Rgb): Rgb {
  const v = /^var\((--[\w-]+)\)$/.exec(value);
  if (v) return colour(tokens, tokens[v[1]], over);
  const mix = /^color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, transparent\)$/.exec(value);
  if (mix) {
    const fg = colour(tokens, tokens[mix[1]], over);
    const a = Number(mix[2]) / 100;
    return fg.map((c, i) => c * a + over[i] * (1 - a)) as Rgb;
  }
  return hex(value);
}

// The strip's marks (Strip.svelte): motion-only clips, AI clips (person,
// vehicle, pet), live events still recording; and the Timeline's kinds.
const MARKS = ['--strip-motion', '--accent', '--danger', '--kind-motion', '--kind-person', '--kind-vehicle', '--kind-pet'];

describe('the strip in dark mode', () => {
  it('is darker than before; light mode is unchanged', () => {
    expect(lum(hex(dark['--strip-empty']))).toBeLessThan(lum(hex('#111827')));
    expect(lum(hex(dark['--strip-stills']))).toBeLessThan(lum(hex('#2B3D63')));
    expect(lum(hex(dark['--strip-outside-b']))).toBeLessThan(lum(hex('#1C2436')));
    for (const t of [light, lightMedia]) {
      expect(t['--strip-empty']).toBe('#C9D2DF');
      expect(t['--strip-stills']).toBe('#EEF3FA');
      expect(t['--strip-outside-a']).toBe('#F5F8FC');
      expect(t['--strip-outside-b']).toBe('#B8C3D3');
      expect(t['--strip-motion']).toBe('color-mix(in srgb, var(--accent-2) 60%, transparent)');
    }
    expect(dark['--strip-empty']).not.toBe(light['--strip-empty']);
  });

  it('gives every clip mark at least 3:1 against the bar and the stills', () => {
    for (const bg of ['--strip-empty', '--strip-stills']) {
      const back = hex(dark[bg]);
      for (const m of MARKS) {
        const r = ratio(colour(dark, dark[m], back), back);
        expect(r, `${m} on ${bg}: ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('keeps the stills apart from the empty bar', () => {
    expect(ratio(hex(dark['--strip-stills']), hex(dark['--strip-empty']))).toBeGreaterThanOrEqual(1.3);
  });
});
