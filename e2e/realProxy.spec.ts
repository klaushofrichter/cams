import { readFileSync } from 'fs';
import { expect, test, type Download, type Page } from '@playwright/test';
import { zipNames } from '../test/proxy/fakeArchive';
import { REAL_PROXY, REAL_PROXY_ON } from './env';
import { signIn } from './session';
import { eventCount, expandAllHours } from './hours';
import { CONTROL_TOKEN, SIMS } from './sims';

// Across the stack (spec 2026-10-02-recordings-via-proxy-design): Silo's
// cam-sim refuses HTTP Download, the real cam-proxy fetches the SD recording
// over Baichuan, and cams plays it and saves it in 4K (the main stream).
test.skip(!REAL_PROXY_ON, 'needs the real cam-proxy: GitHub Actions or CAMS_E2E_REAL_PROXY=1, on Linux (e2e/env.ts)');

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

const card = (page: Page, hhmmss: string) => page.locator(`[data-testid="event-card"][data-clip-id*="-${hhmmss}-"]`);

test('Silo plays and saves a recording its camera refuses over HTTP', async ({ page }) => {
  await page.goto('/app/recordings?cam=silo&panel=events');
  // Hours far from the landing collapse (stage 2), so count from the hour
  // titles, then open them all for the card below.
  await expect.poll(() => eventCount(page), { timeout: 30_000 }).toBe(4);
  await expandAllHours(page);
  await expect(page.getByTestId('event-card')).toHaveCount(4);
  await expect(page.getByTestId('recordings-source')).toHaveText('Source of recordings and thumbnails: cam-proxy (SD card)');
  await card(page, '120505').click();
  const video = page.getByTestId('clip-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.currentTime > 0.5), { timeout: 30_000 }).toBe(true);
  await page.locator('li', { has: card(page, '120505') }).getByTestId('event-download').click();
  await page.getByTestId('compose-size').selectOption('4k');
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('compose-save').click()]);
  expect(file.suggestedFilename()).toMatch(/^silo-\d{4}-\d{2}-\d{2}_12-05-05-main\.mp4$/);
  const bytes = readFileSync((await file.path())!);
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  // The proxy fetched over Baichuan: its HTTP Download is refused.
  const status = (await (await page.request.get(`http://127.0.0.1:${REAL_PROXY.port}/control/status`, { headers: { Authorization: `Bearer ${REAL_PROXY.adminToken}` } })).json()) as { recordings: { last: { result: string } | null } };
  expect(status.recordings.last?.result).toBe('ok');
});

// --- Two cameras on one cam-proxy (cam-proxy spec 2026-10-05 multi-camera;
// cams plan 2026-10-05-multi-camera-p3-cams, Task 11). Silo and Loft are
// both cameras of the one real proxy: one proxy group in cams.

const PROXY = `http://127.0.0.1:${REAL_PROXY.port}`;
const asClient = { Authorization: `Bearer ${REAL_PROXY.token}` };
const asAdmin = { Authorization: `Bearer ${REAL_PROXY.adminToken}` };

// The proxy's own stream, read for `ms` (from the start of its log): each
// message's type and camera.
async function proxyStream(query: string, ms = 2000): Promise<{ type: string; cam: string | null }[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  let text = '';
  try {
    const res = await fetch(`${PROXY}/api/stream?since=0${query}`, { headers: asClient, signal: abort.signal });
    expect(res.status, `stream ${query}`).toBe(200);
    for await (const chunk of res.body!) text += Buffer.from(chunk).toString('utf8');
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
  }
  return text.split(/\n\n/).flatMap((f) => {
    const type = /^event: (.+)$/m.exec(f)?.[1];
    const data = /^data: (.+)$/m.exec(f)?.[1];
    if (!type || !data || type === 'reset') return [];
    const cam = (JSON.parse(data) as { cam?: unknown }).cam;
    return [{ type, cam: typeof cam === 'string' ? cam : null }];
  });
}

// What cams relays to browsers (/api/events/stream), collected in the page.
interface Seen { t: number; event: string; data: { cam?: string; type?: string; kind?: string; phase?: string; up?: boolean } }
async function watchRelay(page: Page): Promise<() => Promise<Seen[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __seen: Seen[] };
    w.__seen = [];
    const es = new EventSource('/api/events/stream');
    for (const ev of ['proxy', 'change', 'archive']) es.addEventListener(ev, (e) => w.__seen.push({ t: Date.now(), event: ev, data: JSON.parse((e as MessageEvent).data) }));
  });
  return () => page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen);
}

test('Silo and Loft are listed from one cam-proxy, which cams streams from once, with its camera list', async ({ page }) => {
  // The proxy serves both, and says it filters its stream by a list of cameras.
  const list = (await (await page.request.get(`${PROXY}/api/cameras`, { headers: asClient })).json()) as { id: string; name: string; features?: string[] }[];
  expect(list.map((c) => [c.id, c.name])).toEqual([['silo', 'Silo'], ['loft', 'Loft']]);
  for (const c of list) expect(c.features, c.id).toContain('sse-cam-list');
  // cams lists both, each with the proxy, reachable.
  const cams = (await (await page.request.get('/api/cameras')).json()) as { id: string; name: string; proxy: boolean }[];
  expect(cams.filter((c) => ['silo', 'loft'].includes(c.id)).map((c) => [c.id, c.name, c.proxy])).toEqual([['silo', 'Silo', true], ['loft', 'Loft', true]]);
  for (const id of ['silo', 'loft']) expect(((await (await page.request.get(`/api/cameras/${id}/proxy/info`)).json()) as { reachable: boolean }).reachable, id).toBe(true);
  // One proxy group: the Archive reaches it once, through Silo, for both.
  const archive = (await (await page.request.get('/api/archive')).json()) as { proxies: { via: string; cams: string[]; ok: boolean }[] };
  expect(archive.proxies.filter((p) => p.cams.includes('silo') || p.cams.includes('loft'))).toEqual([{ via: 'silo', cams: ['silo', 'loft'], ok: true }]);
  // One upstream stream per cams server (the main one and the token-login
  // one), not one per camera. The other project's probes below come and go.
  const clients = async () => ((await (await page.request.get(`${PROXY}/control/status`, { headers: asAdmin })).json()) as { sse: { clients: number } }).sse.clients;
  await expect.poll(clients, { timeout: 30_000 }).toBe(2);
  // The list filter cams subscribes with (?cam=<its ids>): this proxy keeps
  // to it, where an older one compared the whole list as one id (nothing).
  const both = await proxyStream('&cam=loft,silo');
  const cams2 = new Set(both.map((m) => m.cam));
  expect(cams2.has('silo') && cams2.has('loft'), [...cams2].join(',')).toBe(true);
  expect([...cams2].every((c) => c === 'silo' || c === 'loft')).toBe(true);
  expect(new Set((await proxyStream('&cam=loft')).map((m) => m.cam))).toEqual(new Set(['loft']));
});

// The shared stream gives each camera its own events: one on Loft's cam-sim
// reaches Loft (relay, notice, its list) and never Silo. Desktop and phone
// both fire on Loft, never on Silo, so Silo stays at its four demo recordings.
test('an event on Loft reaches Loft only, through the shared stream', async ({ page }) => {
  test.setTimeout(240_000);
  const seen = await watchRelay(page);
  await page.goto('/app/recordings?cam=silo&panel=events');
  await expect.poll(async () => (await seen()).filter((s) => s.event === 'proxy' && s.data.up).map((s) => s.data.cam).filter((c) => c === 'silo' || c === 'loft').sort(), { timeout: 30_000 }).toEqual(['loft', 'silo']);
  const since = Date.now();
  const fired = await page.request.post(`http://127.0.0.1:${SIMS.loft.control}/sim/api/events`, { headers: { Authorization: `Bearer ${CONTROL_TOKEN}` }, data: { type: 'person', durationS: 5 } });
  expect(fired.ok()).toBe(true);
  const camEvents = async (cam: string) => (await seen()).filter((s) => s.t >= since && s.event === 'change' && s.data.cam === cam && s.data.type === 'camera-event');
  await expect.poll(async () => (await camEvents('loft')).some((s) => s.data.kind === 'person' && s.data.phase === 'end'), { timeout: 60_000 }).toBe(true);
  await page.waitForTimeout(5000); // anything late for Silo
  expect(await camEvents('silo')).toEqual([]);
  await expect.poll(() => eventCount(page), { timeout: 30_000 }).toBe(4);
  // Its recording joins Loft's list (once the camera has closed the file).
  await page.goto('/app/recordings?cam=loft&panel=events');
  await expect
    .poll(
      async () => {
        await page.reload();
        await page.getByTestId('hour-count').first().waitFor({ timeout: 15_000 }).catch(() => undefined);
        return eventCount(page);
      },
      { timeout: 120_000, intervals: [5000] },
    )
    .toBeGreaterThan(4);
});

// The Archive across the two cameras: a clip of each, kept on the one proxy
// (reached through Silo), listed with its own camera; a ZIP of Loft's clip is
// named after Loft (the proxy itself calls it "archive-all-…"), one of both
// after Silo, the camera cams reaches the proxy through. Desktop only: the
// proxy takes 4 ZIPs and 10 new clips a minute from cams, both projects included.
test('the Archive holds clips of both cameras on the one proxy, and names their ZIPs', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the proxy’s rate limits: desktop only');
  test.setTimeout(240_000);
  const tag = `e2e-mc ${Date.now().toString(36)}`;
  const made: { cam: string; id: number }[] = [];
  try {
    for (const cam of ['silo', 'loft'] as const) {
      await page.goto(`/app/recordings?cam=${cam}&panel=events`);
      await expect.poll(() => eventCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
      await expandAllHours(page);
      const clipId = (await card(page, '120505').first().getAttribute('data-clip-id'))!;
      const res = await page.request.post(`/api/cameras/${cam}/archive`, { data: { source: { type: 'event', eventId: clipId, quality: 'sub' }, name: `${tag} ${SIMS[cam].name}`, labels: ['e2e'] }, timeout: 60_000 });
      expect([201, 202], `archive ${clipId} of ${cam}: ${res.status()}`).toContain(res.status());
      let job = (await res.json()) as { id: string; via: string; state: string; item?: { id: number } | null };
      expect(job.via).toBe('silo'); // the group's first camera, for Loft too
      await expect
        .poll(
          async () => {
            if (job.state !== 'done' && job.state !== 'failed' && job.state !== 'cancelled') job = (await (await page.request.get(`/api/archive/silo/jobs/${job.id}`)).json()) as typeof job;
            return job.state;
          },
          { timeout: 120_000, intervals: [2000] },
        )
        .toBe('done');
    }
    const list = (await (await page.request.get(`/api/archive?q=${encodeURIComponent(tag)}`)).json()) as { items: { via: string; id: number; camera: string | null; cam: string; name: string; cameraName: string }[] };
    const mine = list.items.filter((x) => x.name.startsWith(tag));
    made.push(...mine.map((x) => ({ cam: x.camera!, id: x.id })));
    expect(mine.map((x) => [x.name, x.camera, x.cam, x.via, x.cameraName]).sort()).toEqual([
      [`${tag} Loft`, 'loft', 'loft', 'silo', 'Loft'],
      [`${tag} Silo`, 'silo', 'silo', 'silo', 'Silo'],
    ]);

    await page.goto('/app/archive');
    await page.getByTestId('archive-search').fill(tag);
    const rows = page.getByTestId('archive-row');
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    const row = (name: string) => rows.filter({ has: page.getByTestId('archive-name-cell').getByText(`${tag} ${name}`, { exact: true }) });
    for (const name of ['Silo', 'Loft']) await expect(row(name)).toContainText(name);
    const zip = async (): Promise<Download> => {
      const [d] = await Promise.all([page.waitForEvent('download'), page.getByTestId('archive-bulk-zip').click()]);
      return d;
    };
    // Loft's clip alone: named after Loft.
    await row('Loft').getByTestId('archive-select').click();
    await expect(page.getByTestId('archive-selected-count')).toHaveText('1 selected');
    const loft = await zip();
    expect(loft.suggestedFilename()).toMatch(/^archive-loft-\d{8}-\d{6}\.zip$/);
    const loftId = mine.find((x) => x.camera === 'loft')!.id;
    expect(zipNames(readFileSync((await loft.path())!))).toEqual(expect.arrayContaining([`${tag} Loft (${loftId}).mp4`, `${tag} Loft (${loftId}).json`]));
    // Both: one ZIP (one proxy), named after Silo.
    await row('Silo').getByTestId('archive-select').click();
    await expect(page.getByTestId('archive-selected-count')).toHaveText('2 selected');
    const both = await zip();
    expect(both.suggestedFilename()).toMatch(/^archive-silo-\d{8}-\d{6}\.zip$/);
    expect(zipNames(readFileSync((await both.path())!)).filter((n) => n.endsWith('.mp4')).sort()).toEqual(mine.map((x) => `${x.name} (${x.id}).mp4`).sort());
  } finally {
    for (const m of made) await page.request.delete(`/api/archive/silo/items/${m.id}`);
  }
});
