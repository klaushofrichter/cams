import { describe, expect, it } from 'vitest';
import { ICONS } from './icons';
import { ADMIN_CONSOLE_URL, HIGHLIGHTS, NUMBERS, REPOS, SECTIONS, SHOWCASE } from './landingContent';

// The landing page is public and pre-login: its copy must not carry
// addresses, host names, ids or tokens. Links live in their own fields.
const allText = (): string[] => [
  ...HIGHLIGHTS.flatMap((h) => [h.kicker, h.title, h.text]),
  ...NUMBERS.flatMap((n) => [n.label]),
  ...SECTIONS.flatMap((s) => [s.kicker, s.title, s.lead, ...s.features.flatMap((f) => [f.title, f.text]), ...(s.shots ?? []).map((x) => x.alt)]),
  ...REPOS.map((r) => r.text),
  SHOWCASE.desktop.alt,
  SHOWCASE.phone.alt,
];

describe('landing content', () => {
  it('has highlights that each point to a section further down', () => {
    expect(HIGHLIGHTS.length).toBeGreaterThanOrEqual(3);
    expect(HIGHLIGHTS.length).toBeLessThanOrEqual(8);
    const ids = new Set(SECTIONS.map((s) => s.id));
    for (const h of HIGHLIGHTS) expect(ids.has(h.section), h.section).toBe(true);
    // Every section is summarised once at the top.
    expect(new Set(HIGHLIGHTS.map((h) => h.section)).size).toBe(HIGHLIGHTS.length);
  });

  it('does not repeat a highlight in its section', () => {
    // A highlight summarises; its words are not a feature card's title or text.
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    for (const h of HIGHLIGHTS) {
      const section = SECTIONS.find((s) => s.id === h.section)!;
      for (const t of [section.title, section.lead, ...section.features.flatMap((f) => [f.title, f.text])]) {
        expect(norm(t).includes(norm(h.title)), `${h.title} / ${t}`).toBe(false);
        expect(norm(t).includes(norm(h.text)), `${h.text} / ${t}`).toBe(false);
      }
    }
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

  it('says proxy, never gateway', () => {
    for (const t of allText()) expect(t.toLowerCase(), t).not.toContain('gateway');
  });

  it('links the five public repositories on GitHub, and the admin console', () => {
    expect(REPOS.map((r) => r.url)).toEqual([
      'https://github.com/klaushofrichter/cams',
      'https://github.com/klaushofrichter/cam-proxy',
      'https://github.com/klaushofrichter/cam-sim',
      'https://github.com/klaushofrichter/cams-admin',
      'https://github.com/klaushofrichter/cam-proxy-pi-display',
    ]);
    expect(ADMIN_CONSOLE_URL).toBe('https://cams-admin.skylar.technology');
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
    const names = /^(Google|Vision|Raspberry|Pi|SD|4K|ZIP|AI|APIs?|UI|CA|Reolink|RLC-1224A|GitHub|Kubernetes|Timeline|Video|Archive|Status)$/; // names and the app’s page names
    for (const t of [...HIGHLIGHTS.map((h) => h.title), ...SECTIONS.map((s) => s.title), ...SECTIONS.flatMap((s) => s.features.map((f) => f.title))]) {
      const words = t.split(' ').slice(1);
      expect(words.filter((w) => /^[A-Z]/.test(w) && !names.test(w.replace(/[,.:]/g, ''))), t).toEqual([]);
    }
  });
});
