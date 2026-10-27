import { describe, expect, it } from 'vitest';
import { ICONS } from './icons';
import { HIGHLIGHTS, SECTIONS, SHOWCASE } from './landingContent';

// The landing page is public and pre-login: its copy must not carry
// addresses, host names (other than the company's site), ids or tokens.
const allText = (): string[] => [
  ...HIGHLIGHTS.flatMap((h) => [h.title, h.text]),
  ...SECTIONS.flatMap((s) => [s.title, s.lead, ...s.features.flatMap((f) => [f.title, f.text]), ...(s.shots ?? []).map((x) => x.alt)]),
  SHOWCASE.desktop.alt,
  SHOWCASE.phone.alt,
];

describe('landing content', () => {
  it('has 3 to 6 highlights and at least 3 sections, each with features', () => {
    expect(HIGHLIGHTS.length).toBeGreaterThanOrEqual(3);
    expect(HIGHLIGHTS.length).toBeLessThanOrEqual(6);
    expect(SECTIONS.length).toBeGreaterThanOrEqual(3);
    for (const s of SECTIONS) expect(s.features.length).toBeGreaterThan(0);
  });

  it('uses only icons that exist', () => {
    const names = [...HIGHLIGHTS.map((h) => h.icon), ...SECTIONS.flatMap((s) => s.features.map((f) => f.icon))];
    expect(names.filter((n) => !(n in ICONS))).toEqual([]);
  });

  it('names no address, host, port or id', () => {
    for (const t of allText()) {
      expect(t, t).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/); // IPv4
      expect(t, t).not.toMatch(/:\d{2,5}\b/); // a port
      expect(t, t).not.toMatch(/\b[a-z0-9-]+\.(internal|local|lan|svc|com|net|org|io|technology)\b/i); // a host name
      expect(t, t).not.toMatch(/\bcam\d\b|\bcao_|\bCAC1-/i); // camera ids, tokens
    }
  });

  it('every screenshot is a WebP under /landing/ with alt text and a size', () => {
    const shots = [SHOWCASE.desktop, SHOWCASE.phone, ...SECTIONS.flatMap((s) => s.shots ?? [])];
    for (const x of shots) {
      expect(x.src).toMatch(/^\/landing\/[a-z-]+\.webp$/);
      expect(x.alt.length).toBeGreaterThan(20);
      expect(x.width).toBeGreaterThan(0);
      expect(x.height).toBeGreaterThan(0);
    }
  });

  it('uses sentence-case titles', () => {
    for (const t of [...HIGHLIGHTS.map((h) => h.title), ...SECTIONS.map((s) => s.title)]) {
      const words = t.split(' ').slice(1);
      // Words after the first stay lower case, apart from names.
      const names = /^(Google|Vision|Raspberry|Pi|SD|4K|Wi-Fi|ZIP|AI)$/;
      expect(words.filter((w) => /^[A-Z]/.test(w) && !names.test(w.replace(/[,.]/g, ''))), t).toEqual([]);
    }
  });
});
