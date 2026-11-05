import type { Locator, Page } from '@playwright/test';

// Synthetic fingers through Chromium's real input pipeline (CDP): the browser
// decides on scrolling and zooming as it would for a screen. Not a real iPhone.
type Pt = { x: number; y: number };
const send = (cdp: Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>, type: string, points: (Pt & { id: number })[]) =>
  cdp.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints: points });

// The first finger, then the second, as a hand does: spreading from `from` to
// `to` px apart around the point.
export async function pinch(page: Page, at: Pt, from: number, to: number, steps = 6) {
  const cdp = await page.context().newCDPSession(page);
  const fingers = (gap: number) => [{ x: at.x - gap / 2, y: at.y, id: 1 }, { x: at.x + gap / 2, y: at.y, id: 2 }];
  await send(cdp, 'touchStart', fingers(from).slice(0, 1));
  await send(cdp, 'touchStart', fingers(from));
  for (let i = 1; i <= steps; i++) await send(cdp, 'touchMove', fingers(from + ((to - from) * i) / steps));
  await send(cdp, 'touchEnd', []);
  await cdp.detach();
}

export async function drag(page: Page, from: Pt, to: Pt, steps = 6) {
  const cdp = await page.context().newCDPSession(page);
  await send(cdp, 'touchStart', [{ ...from, id: 1 }]);
  for (let i = 1; i <= steps; i++) await send(cdp, 'touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id: 1 }]);
  await send(cdp, 'touchEnd', []);
  await cdp.detach();
}

export async function doubleTap(page: Page, at: Pt) {
  const cdp = await page.context().newCDPSession(page);
  for (let i = 0; i < 2; i++) {
    await send(cdp, 'touchStart', [{ ...at, id: 1 }]);
    await send(cdp, 'touchEnd', []);
  }
  await cdp.detach();
}

export async function centreOf(el: Locator): Promise<Pt> {
  const b = (await el.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// The element's transform as a view: 1x with no offset when it has none.
export const viewOf = (el: Locator) => el.evaluate((e) => {
  const css = getComputedStyle(e).transform;
  const m = css === 'none' ? new DOMMatrix() : new DOMMatrix(css);
  return { s: m.a, x: m.e, y: m.f };
});
export const pageScale = (page: Page) => page.evaluate(() => window.visualViewport!.scale);
