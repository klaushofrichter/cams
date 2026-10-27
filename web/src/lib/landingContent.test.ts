import { describe, expect, it } from 'vitest';
import { ICONS } from './icons';
import { ADMIN_CONSOLE_URL, EPAPER_PAGES, LLMS_TXT, MCP, HIGHLIGHTS, NUMBERS, REPOS, SECTIONS, SHOWCASE } from './landingContent';

// The landing page is public and pre-login: its copy must not carry
// addresses, host names, ids or tokens. Links live in their own fields.
const allText = (): string[] => [
  ...HIGHLIGHTS.flatMap((h) => [h.kicker, h.title, h.text]),
  ...NUMBERS.flatMap((n) => [n.label]),
  ...SECTIONS.flatMap((s) => [s.kicker, s.title, s.lead, ...s.features.flatMap((f) => [f.title, f.text]), ...(s.shots ?? []).map((x) => x.alt)]),
  ...REPOS.map((r) => r.text),
  LLMS_TXT.text,
  SHOWCASE.desktop.alt,
  SHOWCASE.phone.alt,
  ...EPAPER_PAGES.flatMap((e) => [e.name, e.alt]),
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

  it('the cameras highlight says “Works with Reolink” and points to #cameras', () => {
    const h = HIGHLIGHTS.find((x) => x.section === 'cameras')!;
    expect(h.title).toBe('Works with Reolink');
  });

  it('Find has a card on the secondary AI analytics and its budget, and its highlight mentions it', () => {
    const find = SECTIONS.find((s) => s.id === 'find')!;
    const card = find.features.find((f) => f.title === 'Secondary AI analytics')!;
    expect(card).toBeDefined();
    expect(card.text).toContain('Google Vision');
    expect(card.text).toMatch(/monthly limit/);
    expect(card.text).toMatch(/daily cap/);
    expect(HIGHLIGHTS.find((x) => x.section === 'find')!.text).toMatch(/second AI opinion/);
  });

  it('round 4 copy: 10+ cameras with its estimate, the hardware headline, Save clip around, the AI line', () => {
    expect(NUMBERS.find((n) => n.suffix === '+')).toMatchObject({ value: 10, suffix: '+' });
    expect(NUMBERS.some((n) => n.value === 64)).toBe(false);
    const hw = SECTIONS.find((x) => x.id === 'hardware')!;
    expect(hw.title).toBe('Scales to the requirements');
    expect(hw.lead).toContain('Raspberry Pi');
    expect(hw.lead).not.toContain('tiny board');
    const larger = hw.features.find((f) => f.title === 'Larger proxies, many cameras')!;
    expect(larger.text).toContain('10 or more cameras');
    expect(larger.text).toContain('Estimated for a mini PC class machine (Ryzen 5 mobile CPU, 8 GB RAM, 512 GB NVMe SSD); not yet load-tested.');
    expect(larger.text).toContain('Celeron J1900');
    const around = SECTIONS.find((x) => x.id === 'keep')!.features.find((f) => f.title === 'Save clip around')!;
    expect(around.text.startsWith('Pick a moment in time and save a video. ')).toBe(true);
    expect(SECTIONS.find((x) => x.id === 'open')!.lead).toBe('Your AI can read the code, build new features on the APIs, and manage the system for you from plain-text prompts.');
  });

  it('the fleet section shows the cams-admin dashboard', () => {
    const fleet = SECTIONS.find((x) => x.id === 'fleet')!;
    expect(fleet.shots?.map((x) => x.src)).toEqual(['/landing/admin-dashboard.webp']);
  });

  it('the e-paper display has its four pages, in the display’s order', () => {
    expect(EPAPER_PAGES.map((e) => e.name)).toEqual(['Overview', 'Camera', 'Proxy', 'Pi']);
    for (const e of EPAPER_PAGES) expect(e.src).toBe(`/landing/epaper-${e.name.toLowerCase()}.webp`);
  });

  it('points your AI at llms.txt, relative so a local viewer serves its own', () => {
    expect(LLMS_TXT.href).toBe('/llms.txt');
    expect(LLMS_TXT.text).toBe('Point your AI at llms.txt: every API and its documentation in one list.');
  });

  it('Open has an MCP card, its one-line command and the README link; the highlight mentions MCP', () => {
    const open = SECTIONS.find((x) => x.id === 'open')!;
    const card = open.features.find((f) => f.title === 'Connect your AI assistant')!;
    expect(card.text).toContain('MCP server');
    expect(card.text).toMatch(/revoke/);
    expect(card.text).not.toMatch(/available now|live now/i);
    expect(MCP.command).toBe('claude mcp add --transport http cams https://cams.skylar.technology/mcp --header "Authorization: Bearer cmcp_<your token>"');
    expect(MCP.docs).toBe('https://github.com/klaushofrichter/cams#mcp-server');
    expect(HIGHLIGHTS.find((h) => h.section === 'open')!.text).toMatch(/MCP/);
  });

  it('the MCP card shows 3 or 4 sample prompts with short hints, no tool names', () => {
    expect(MCP.prompts.length).toBeGreaterThanOrEqual(3);
    expect(MCP.prompts.length).toBeLessThanOrEqual(4);
    for (const p of MCP.prompts) {
      expect(p.prompt).not.toMatch(/_/);
      expect(p.hint).not.toMatch(/_/);
      expect(p.hint.length).toBeLessThan(80);
    }
  });

  it('every screenshot is a WebP under /landing/ with alt text and a size', () => {
    const shots = [SHOWCASE.desktop, SHOWCASE.phone, ...EPAPER_PAGES, ...SECTIONS.flatMap((s) => s.shots ?? [])];
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
