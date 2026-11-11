import { Page, Locator, expect, test as base } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { PNG } from 'pngjs';

// Shared by the public-page specs. Adapted from klaushofrichter/
// www-skylar-technology and www-klaushofrichter (walk, axe, gradient stops)
// and klaushofrichter/instagetter (contrast on the real screen pixels), the
// references for kube-setup's "public web pages" baseline.

/** Playwright's test, with one automatic check: no page of any test sends
 *  anything but GET or HEAD to the site. The @live tests run against
 *  production and must never sign in or write (kube-setup's baseline). */
export const test = base.extend<{ readOnly: void }>({
  readOnly: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const writes: string[] = [];
      context.on('request', (r) => {
        if (!['GET', 'HEAD'].includes(r.method()) && new URL(r.url()).origin === origin) writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
      });
      await use();
      expect(writes, 'requests that change something on the site').toEqual([]);
    },
    { auto: true },
  ],
});

/** The public pages a signed-out visitor can open. /token and /signin are
 *  linked from the start page in production (cams-admin mode); the local
 *  server runs the Google-only sign-in, whose button goes to Google instead,
 *  so they are listed here as well as found by the walk. */
export const PUBLIC_PAGES = ['/', '/signin', '/token'] as const;

/** Console errors, uncaught exceptions, CSP violations and failed same-site
 *  requests while a test runs. */
export function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`exception: ${e.message}`));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.origin === new URL(page.url() || r.url()).origin && r.status() >= 400 && !u.pathname.startsWith('/does-not-exist')) {
      problems.push(`HTTP ${r.status()}: ${u.pathname}`);
    }
  });
  page.on('requestfailed', (r) => {
    const failure = r.failure()?.errorText ?? '';
    // A navigation away aborts lazy pictures still in flight; not a fault.
    if (!/ABORTED|cancelled|NS_BINDING_ABORTED|Load request cancelled/i.test(failure)) problems.push(`failed: ${r.url()} ${failure}`);
  });
  return problems;
}

/** CSP violations as console errors, so watchProblems sees them. */
export async function reportCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP: ${e.violatedDirective} ${e.blockedURI}`));
  });
}

/** Scroll the whole page in steps (lazy pictures load, reveals run), then back to the top. */
export async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.7));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 120));
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
}

/** Every <img> has arrived and decoded. WebKit starts a lazy picture only near
 *  the viewport, so each poll brings the first missing one into view. */
export async function expectAllPicturesLoaded(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const missing = Array.from(document.images).filter((img) => !img.complete || img.naturalWidth === 0);
          missing[0]?.scrollIntoView({ block: 'center' });
          return missing.map((img) => img.currentSrc || img.src);
        }),
      { timeout: 20_000, message: 'pictures that did not load' },
    )
    .toEqual([]);
}

/** Open the page in a theme. cams keeps the choice in localStorage
 *  ('cams-theme'), read before the first paint (web/index.html). */
export async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('cams-theme', t);
    } catch {
      /* storage refused: the scheme below decides */
    }
  }, theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
}

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function describeViolations(violations: { impact?: string | null; id: string; help: string; nodes: { target: unknown[]; failureSummary?: string }[] }[]) {
  return violations.map(
    (v) =>
      `${v.impact} ${v.id}: ${v.help}\n    ${v.nodes
        .slice(0, 6)
        .map((n) => `${n.target.join(' ')}  ${n.failureSummary?.split('\n')[1] ?? ''}`)
        .join('\n    ')}`,
  );
}

/** axe-core, WCAG 2.2 A and AA, zero violations. Contrast axe cannot decide
 *  (text over a gradient, a translucent card, a picture: "incomplete", which
 *  Lighthouse scores 100) is measured on the real pixels afterwards
 *  (expectReadableText), over the whole page. */
export async function audit(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  // Soft: the pixel pass that follows still runs and reports too.
  expect.soft(describeViolations(result.violations), 'WCAG 2.2 AA violations').toEqual([]);
}

// --- Contrast on the composited pixels ---------------------------------

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

interface Leaf {
  i: number;
  /** The glyphs' own colour, RGBA 0-255 with the element's opacity folded into the alpha; null for gradient-filled text. */
  rgba: [number, number, number, number] | null;
  size: number;
  weight: number;
  text: string;
}

/**
 * Every visible run of text in `root` (default: the whole page) has 4.5:1
 * (3:1 when large) against the pixels actually behind its glyphs.
 *
 * axe and Lighthouse cannot judge text over a gradient, a translucent card or
 * a picture; the start page has all three. Per run of text: two screenshots of
 * its box, one as a reader sees it and one with only that text made
 * transparent. Where they differ is where its glyphs are painted, and the
 * second shot is what lies behind them (gradients, translucency, the picture).
 * The glyph colour is the element's colour (with its alpha and opacity) over
 * that pixel; for gradient-filled text (background-clip: text) a third shot
 * paints the gradient over the whole box and gives it per pixel.
 *
 * The box is scrolled into view and the clip clamped to the viewport: WebKit
 * fails a clip that reaches outside it (instagetter).
 */
export async function expectReadableText(page: Page, label: string, root: Locator | null = null): Promise<void> {
  const leaves: Leaf[] = await (root ?? page.locator('body')).evaluate((el) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    // Any CSS colour (color-mix, oklab, color(srgb ...)) to RGBA bytes.
    const rgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    };
    const owns = (e: Element) => Array.from(e.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0);
    const out: Leaf[] = [];
    let i = 0;
    for (const e of [el, ...Array.from(el.querySelectorAll('*'))]) {
      // Decorative (aria-hidden) and disabled controls are exempt from WCAG 1.4.3, as in axe.
      if (!owns(e) || e.closest('[aria-hidden="true"], script, style, noscript, title, :disabled')) continue;
      const h = e as HTMLElement;
      const s = getComputedStyle(h);
      const r = h.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || s.visibility !== 'visible' || h.closest('.nt-hint')) continue;
      // A visually hidden run (clip-path inset 50%, 1px boxes): not drawn.
      if (r.width <= 1 && r.height <= 1) continue;
      let opacity = 1;
      for (let n: Element | null = h; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
      if (opacity < 0.05) continue;
      const clipText = s.backgroundClip === 'text' || (s as unknown as Record<string, string>).webkitBackgroundClip === 'text';
      const fill = (s as unknown as Record<string, string>).webkitTextFillColor || s.color;
      const strokeW = parseFloat((s as unknown as Record<string, string>).webkitTextStrokeWidth || '0');
      let colour: [number, number, number, number] | null;
      if (clipText && s.backgroundImage !== 'none') colour = null;
      else {
        colour = rgba(fill);
        // Outlined text (transparent fill, a stroke): the stroke is the glyph.
        if (colour[3] === 0 && strokeW > 0) colour = rgba((s as unknown as Record<string, string>).webkitTextStrokeColor);
      }
      if (colour) colour[3] = Math.round(colour[3] * opacity);
      h.dataset.contrastLeaf = String(i);
      out.push({ i, rgba: colour, size: parseFloat(s.fontSize), weight: Number(s.fontWeight) || 400, text: (h.textContent ?? '').trim().slice(0, 40) });
      i++;
    }
    return out;
  });
  expect(leaves.length, `${label}: no text to measure`).toBeGreaterThan(0);
  const failures: string[] = [];
  try {
    for (const leaf of leaves) {
      const f = await measureLeaf(page, leaf);
      if (f) failures.push(f);
    }
  } finally {
    await page.evaluate(() => document.querySelectorAll('[data-contrast-leaf]').forEach((e) => e.removeAttribute('data-contrast-leaf')));
  }
  expect(failures, `${label}: text below WCAG AA contrast on the real pixels`).toEqual([]);
}

async function shot(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<PNG> {
  return PNG.sync.read(await page.screenshot({ clip, animations: 'disabled', caret: 'hide' }));
}

/** One run of text; a failure message, or null. */
async function measureLeaf(page: Page, leaf: Leaf): Promise<string | null> {
  const loc = page.locator(`[data-contrast-leaf="${leaf.i}"]`);
  await loc.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  const box = await loc.boundingBox();
  if (!box) return null;
  const view = page.viewportSize()!;
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const width = Math.min(Math.ceil(box.x + box.width) - x, view.width - x);
  const height = Math.min(Math.ceil(box.y + box.height) - y, view.height - y);
  if (width < 2 || height < 2) return null;
  const clip = { x, y, width, height };

  const hide = (mode: 'hide' | 'paint' | 'restore') =>
    loc.evaluate((e, mode) => {
      const h = e as HTMLElement;
      if (mode === 'restore') {
        h.setAttribute('style', h.dataset.contrastStyle ?? '');
        if (!h.getAttribute('style')) h.removeAttribute('style');
        delete h.dataset.contrastStyle;
        return;
      }
      if (h.dataset.contrastStyle === undefined) h.dataset.contrastStyle = h.getAttribute('style') ?? '';
      h.style.setProperty('transition', 'none', 'important');
      if (mode === 'hide') {
        h.style.setProperty('color', 'transparent', 'important');
        h.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
        h.style.setProperty('-webkit-text-stroke-color', 'transparent', 'important');
        // Gradient-filled text: its background IS the glyphs.
        if (getComputedStyle(h).backgroundClip === 'text' || (getComputedStyle(h) as unknown as Record<string, string>).webkitBackgroundClip === 'text') {
          h.style.setProperty('background-image', 'none', 'important');
        }
      } else {
        // The gradient over the whole box, the glyphs out of the way.
        h.style.setProperty('-webkit-background-clip', 'border-box', 'important');
        h.style.setProperty('background-clip', 'border-box', 'important');
        h.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
        h.style.setProperty('color', 'transparent', 'important');
      }
    }, mode);

  const withText = await shot(page, clip);
  let behind: PNG;
  let paint: PNG | null = null;
  try {
    await hide('hide');
    behind = await shot(page, clip);
    if (!leaf.rgba) {
      await hide('restore');
      await hide('paint');
      paint = await shot(page, clip);
    }
  } finally {
    await hide('restore');
  }
  if (withText.width !== behind.width || withText.height !== behind.height) return null;

  const a = withText.data;
  const b = behind.data;
  let worst = Infinity;
  let worstAt: [number, number, number] = [0, 0, 0];
  let worstText: [number, number, number] = [0, 0, 0];
  let sampled = 0;
  const ratios: number[] = [];
  for (let p = 0; p + 3 < a.length; p += 4) {
    const diff = Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
    // Only pixels a glyph really covers; anti-aliased edges are part
    // background and would report a contrast no reader sees.
    if (diff < 60) continue;
    const [br, bg, bb] = [b[p], b[p + 1], b[p + 2]];
    let t: [number, number, number];
    if (leaf.rgba) {
      const al = leaf.rgba[3] / 255;
      t = [leaf.rgba[0] * al + br * (1 - al), leaf.rgba[1] * al + bg * (1 - al), leaf.rgba[2] * al + bb * (1 - al)];
    } else {
      t = [paint!.data[p], paint!.data[p + 1], paint!.data[p + 2]];
    }
    const c = ratio(luminance(...t), luminance(br, bg, bb));
    sampled++;
    ratios.push(c);
    if (c < worst) {
      worst = c;
      worstAt = [br, bg, bb];
      worstText = t.map(Math.round) as [number, number, number];
    }
  }
  if (sampled < 4) return null;
  // The worst 2 % of glyph pixels may be lower (a sub-pixel seam where two
  // gradient pixels meet); a real failure covers far more of the text.
  ratios.sort((p, q) => p - q);
  const judged = ratios[Math.floor(ratios.length * 0.02)];
  const large = leaf.size >= 24 || (leaf.size >= 18.66 && leaf.weight >= 700);
  const floor = large ? 3 : 4.5;
  if (judged >= floor) return null;
  return `"${leaf.text}" (${leaf.size}px/${leaf.weight}): ${judged.toFixed(2)}:1, needs ${floor}:1 — worst rgb(${worstText.join(',')}) over rgb(${worstAt.join(',')}), ${sampled} glyph pixels`;
}
