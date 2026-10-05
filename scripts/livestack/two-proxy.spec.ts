// One cams, two cam-proxies (docs/livestack.md, "Two proxies"): the checks
// against a stack start-two-proxy-stack.sh started, run by
// check-two-proxy.sh (two-proxy.config.ts). In order, one worker: later
// steps use what earlier ones made (a clip per camera, archived clips), and
// the outage step stops proxy B. Not serial mode: a failed step is reported
// and the next ones still run (a step whose input is missing fails at once).
//
// Camera A ("Alpha", a-cam1) is cam1 on proxy A; camera B ("Bravo", b-cam1)
// is cam1 on proxy B. Every event is one this file triggers on a cam-sim's
// control API (the sims make none of their own), so each can be traced to the
// proxy it must reach, and away from the one it must not.
//
// Talks to cams only as a signed-in browser would (a session cookie signed
// with the run's COOKIE_SECRET), plus the cam-sims' control API to make
// events. Tokens stay in memory; nothing secret is printed.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { runEnv } from './two-proxy-env';

const env = runEnv();
const A = env.CAMS_A; // a-cam1
const B = env.CAMS_B.split(',')[0]; // b-cam1 (the first of proxy B's cameras)
const NAME: Record<string, string> = { [A]: 'Alpha', [B]: 'Bravo' };
const SIM = { [A]: { url: env.SIM_A_CONTROL_URL, token: env.SIM_A_CONTROL_TOKEN }, [B]: { url: env.SIM_B_CONTROL_URLS.split(',')[0], token: env.SIM_B_CONTROL_TOKEN } };
const START = join(__dirname, 'start-two-proxy-stack.sh');
// Names this run's archived clips; set once in two-proxy.config.ts, so a
// worker started again after a failed step keeps it.
const RUN = `tp${process.env.TWOPROXY_RUN_ID ?? Date.now().toString(36)}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: env.CAM_TZ || 'America/Chicago' }).format(new Date());

async function signIn(context: BrowserContext): Promise<void> {
  const value = jwt.sign({ email: env.SESSION_EMAIL }, env.CAMS_COOKIE_SECRET, { expiresIn: '1h' });
  await context.addCookies([{ name: 'session', value, domain: new URL(env.CAMS_URL).hostname, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
}

async function trigger(cam: string, type: string, durationS = 6): Promise<number> {
  const at = Date.now();
  const res = await fetch(`${SIM[cam].url}/sim/api/events`, { method: 'POST', headers: { Authorization: `Bearer ${SIM[cam].token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type, durationS }) });
  expect(res.status, `trigger ${type} on ${NAME[cam]}'s cam-sim`).toBeLessThan(300);
  return at;
}

async function getJson<T>(req: APIRequestContext, path: string): Promise<{ status: number; body: T }> {
  const r = await req.get(path);
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status(), body: body as T };
}

// The monitor: one page that stays open all along, recording what cams
// relays (/api/events/stream: proxy states and changes) and every live
// notification the top bar shows. Its own EventSource sits next to the app's.
interface Seen { t: number; event: string; data: { cam?: string; type?: string; kind?: string; phase?: string; ts?: number | null; up?: boolean } }
interface Notice { t: number; text: string }
let monitor: Page;
const seen = async (): Promise<Seen[]> => monitor.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen);
const notices = async (): Promise<Notice[]> => monitor.evaluate(() => (window as unknown as { __notices: Notice[] }).__notices);
const eventsFor = (list: Seen[], cam: string, since: number) => list.filter((s) => s.event === 'change' && s.data.cam === cam && s.t >= since);

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  await signIn(context);
  monitor = await context.newPage();
  await monitor.addInitScript(() => {
    const w = window as unknown as { __seen: Seen[]; __notices: Notice[] };
    w.__seen = [];
    w.__notices = [];
    const es = new EventSource('/api/events/stream');
    for (const ev of ['proxy', 'change', 'archive', 'cameras', 'camera']) {
      es.addEventListener(ev, (e) => {
        let data = {};
        try {
          data = JSON.parse((e as MessageEvent).data);
        } catch {
          /* not JSON */
        }
        w.__seen.push({ t: Date.now(), event: ev, data });
      });
    }
    let last = '';
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="live-notice"]');
      const text = el?.textContent?.trim() ?? '';
      if (text && text !== last) w.__notices.push({ t: Date.now(), text });
      last = text;
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await monitor.goto(`/app/video?cam=${A}`);
  await expect(monitor.getByTestId('topbar')).toBeVisible();
  await expect.poll(async () => (await seen()).filter((s) => s.event === 'proxy' && s.data.up === true).map((s) => s.data.cam).sort(), { timeout: 30_000 }).toEqual([A, ...env.CAMS_B.split(',')].sort());
});

test.beforeEach(async ({ context }) => {
  await signIn(context);
});

test('both cameras are listed, each with its own cam-proxy', async ({ page }) => {
  const { status, body } = await getJson<{ id: string; name: string; proxy: boolean }[]>(page.request, '/api/cameras');
  expect(status).toBe(200);
  // Proxy B may serve several cameras (TWOPROXY_B_CAMS, cam-proxy P1): Bravo, Bravo 2, …
  const all = [A, ...env.CAMS_B.split(',')];
  const names = all.map((id, i) => NAME[id] ?? `Bravo ${i}`);
  expect(body.map((c) => [c.id, c.name, c.proxy])).toEqual(all.map((id, i) => [id, names[i], true]));
  await page.goto(`/app/video?cam=${A}`);
  await expect(page.getByTestId('camera-picker').locator('option')).toHaveText(names);
});

for (const cam of [A, B]) {
  test(`live view and snapshot: ${cam}`, async ({ page }) => {
    await page.goto(`/app/video?cam=${cam}`);
    await expect(page.getByTestId('camera-card-name')).toHaveText(NAME[cam]);
    await expect(page.getByTestId('camera-status')).toHaveAttribute('data-state', 'online', { timeout: 30_000 });
    // Its proxy answers (the "Proxy" mark is no "unreachable" one).
    await expect(page.getByTestId('camera-card-proxy')).not.toHaveAttribute('data-reachable', 'false');
    await expect(page.getByTestId('live-badge')).toContainText('LIVE', { timeout: 30_000 });
    await expect(page.getByTestId('stream-indicator')).toHaveAttribute('data-state', 'streaming', { timeout: 30_000 });
    const snap = await page.request.get(`/api/cameras/${cam}/snapshot.jpg`);
    expect(snap.status()).toBe(200);
    expect((await snap.body()).subarray(0, 2).toString('hex')).toBe('ffd8');
    const info = await getJson<{ reachable: boolean }>(page.request, `/api/cameras/${cam}/proxy/info`);
    expect(info.body.reachable).toBe(true);
  });
}

// One person event on each camera, at once: each proxy's stills, a clip of
// each (FTP to its own proxy, listed and played through cams), and a top-bar
// notice for each.
const clipOf: Record<string, string> = {};
test('stills, a clip and a notice per camera', async ({ page }) => {
  const since = Date.now();
  await Promise.all([trigger(A, 'person', 6), trigger(B, 'person', 6)]);
  await expect.poll(async () => (await notices()).filter((n) => n.t >= since).map((n) => n.text), { timeout: 30_000 }).toEqual(expect.arrayContaining(['Person on Alpha', 'Person on Bravo']));
  for (const cam of [A, B]) {
    const now = Date.now();
    const stills = await getJson<unknown[]>(page.request, `/api/cameras/${cam}/stills?from=${now - 120_000}&to=${now}`);
    expect(stills.status, `${cam} stills`).toBe(200);
    expect(stills.body.length, `${cam} stills in the last 2 min`).toBeGreaterThan(0);
    const latest = await page.request.get(`/api/cameras/${cam}/still/latest.jpg`);
    expect(latest.status(), `${cam} latest still`).toBe(200);
    expect((await latest.body()).subarray(0, 2).toString('hex')).toBe('ffd8');
  }
  // The recording of that event (it starts a few seconds before the
  // trigger), listed for each camera, and its clip ended (the FTP upload).
  for (const cam of [A, B]) {
    await expect
      .poll(
        async () => {
          const { body } = await getJson<{ events: { id: string; start: string; end: string | null; triggers: string[]; sizeSub: number | null }[] }>(page.request, `/api/cameras/${cam}/events?date=${today()}`);
          const ev = (body?.events ?? []).find((e) => Date.parse(e.start) >= since - 30_000 && e.triggers.includes('person') && e.sizeSub);
          if (ev) clipOf[cam] = ev.id;
          return !!ev;
        },
        { timeout: 120_000, intervals: [3000] },
      )
      .toBe(true);
    const video = await page.request.get(`/api/cameras/${cam}/clips/${clipOf[cam]}/video`, { timeout: 120_000 });
    expect(video.status(), `${cam} plays ${clipOf[cam]}`).toBe(200);
    expect((await video.body()).subarray(4, 8).toString('latin1')).toBe('ftyp');
  }
  // Each relayed event names its own camera: nothing for one camera arrived
  // only on the other.
  const list = await seen();
  expect(eventsFor(list, A, since).some((s) => s.data.type === 'camera-event' && s.data.kind === 'person')).toBe(true);
  expect(eventsFor(list, B, since).some((s) => s.data.type === 'camera-event' && s.data.kind === 'person')).toBe(true);
});

// An event on one camera reaches that camera only: never the other proxy's
// camera, and (proxy B with several cameras, P1) never its neighbours. Both
// proxies call their camera "cam1": a mix-up in cams' per-proxy fan-out
// would show here.
const ALL = [A, ...env.CAMS_B.split(',')];
const nameOf = (id: string) => NAME[id] ?? `Bravo ${ALL.indexOf(id)}`;
for (const from of [A, B]) {
  const others = ALL.filter((c) => c !== from);
  test(`an event on ${NAME[from]} never shows for ${others.map(nameOf).join(', ')}`, async () => {
    const since = Date.now();
    await trigger(from, 'vehicle', 4);
    await expect.poll(async () => eventsFor(await seen(), from, since).some((s) => s.data.type === 'camera-event' && s.data.kind === 'vehicle' && s.data.phase === 'end'), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await notices()).filter((n) => n.t >= since).map((n) => n.text), { timeout: 10_000 }).toContain(`Vehicle on ${NAME[from]}`);
    await new Promise((r) => setTimeout(r, 8000)); // anything late for another camera
    for (const other of others) {
      const leaked = eventsFor(await seen(), other, since).filter((s) => s.data.type === 'camera-event' || s.data.type === 'clip');
      expect(leaked, `changes for ${other} after an event on ${NAME[from]} only`).toEqual([]);
      expect((await notices()).filter((n) => n.t >= since && n.text.endsWith(`on ${nameOf(other)}`))).toEqual([]);
    }
  });
}

// The Archive merges both proxies: one clip archived on each (both get id 1
// or the like on their own proxy; cams keeps them apart by proxy), listed with
// the right camera, and one ZIP per proxy.
test('the Archive merges both proxies', async ({ page }) => {
  expect(Object.keys(clipOf).sort(), 'a clip per camera from the step before').toEqual([A, B].sort());
  for (const cam of [A, B]) {
    const res = await page.request.post(`/api/cameras/${cam}/archive`, { data: { source: { type: 'event', eventId: clipOf[cam], quality: 'sub' }, name: `${RUN} ${NAME[cam]}`, labels: ['livestack'] }, timeout: 60_000 });
    expect([201, 202], `archive ${clipOf[cam]} of ${cam}: ${res.status()} ${await res.text()}`).toContain(res.status());
    let job = (await res.json()) as { id: string; via: string; state: string };
    // A proxy is reached through its first camera: each camera's own here.
    expect(job.via).toBe(cam);
    const via = job.via;
    await expect
      .poll(
        async () => {
          if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return job.state;
          job = (await getJson<typeof job>(page.request, `/api/archive/${via}/jobs/${job.id}`)).body;
          return job.state;
        },
        { timeout: 120_000, intervals: [2000] },
      )
      .toBe('done');
  }
  const list = await getJson<{ items: { via: string; id: number; camera: string | null; cam: string; name: string }[]; proxies: { via: string; ok: boolean }[] }>(page.request, `/api/archive?q=${RUN}`);
  expect(list.status).toBe(200);
  expect(list.body.proxies.map((p) => [p.via, p.ok]).sort()).toEqual([
    [A, true],
    [B, true],
  ]);
  const mine = list.body.items.filter((x) => x.name.startsWith(RUN));
  expect(mine.map((x) => [x.name, x.camera, x.cam, x.via]).sort()).toEqual([
    [`${RUN} Alpha`, A, 'cam1', A],
    [`${RUN} Bravo`, B, 'cam1', B],
  ]);
  // The Archive page: both rows, each with its camera's name.
  await page.goto('/app/archive');
  await page.getByTestId('archive-search').fill(RUN);
  const rows = page.getByTestId('archive-row');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  for (const cam of [A, B]) {
    const row = rows.filter({ has: page.getByTestId('archive-name-cell').getByText(`${RUN} ${NAME[cam]}`, { exact: true }) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(NAME[cam]);
    await expect(row).toHaveAttribute('data-key', new RegExp(`^${cam}:\\d+$`));
  }
  // Both selected, Download ZIP: one ZIP per cam-proxy.
  await page.getByTestId('archive-select-all').click();
  await expect(page.getByTestId('archive-selected-count')).toHaveText('2 selected');
  const downloads: import('@playwright/test').Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await page.getByTestId('archive-bulk-zip').click();
  await expect(page.getByTestId('archive-notice')).toContainText('2 ZIP files: one per cam-proxy');
  await expect.poll(() => downloads.length, { timeout: 30_000 }).toBe(2);
  // cams names each ZIP after its camera (cams #215): archive-<camera>-<time>.zip,
  // apart even though both proxies call their camera cam1.
  const names = downloads.map((d) => d.suggestedFilename()).sort();
  expect(names).toEqual([expect.stringMatching(new RegExp(`^archive-${A}-\\d{8}-\\d{6}\\.zip$`)), expect.stringMatching(new RegExp(`^archive-${B}-\\d{8}-\\d{6}\\.zip$`))]);
  for (const d of downloads) {
    const bytes = readFileSync((await d.path())!);
    expect(bytes.subarray(0, 2).toString('latin1'), d.suggestedFilename()).toBe('PK');
    expect(bytes.length).toBeGreaterThan(10_000);
  }
});

// Proxy B stops: camera A goes on; camera B's proxy shows unreachable. Then
// B comes back: its events flow again, and nothing from before is replayed.
let restartedAt = 0;
test('proxy B down: camera A keeps working, camera B shows its proxy unreachable', async ({ page }) => {
  const since = Date.now();
  execFileSync('bash', [START, '--stop-proxy-b'], { stdio: 'inherit' });
  await expect.poll(async () => (await seen()).some((s) => s.t >= since && s.event === 'proxy' && s.data.cam === B && s.data.up === false), { timeout: 60_000 }).toBe(true);
  expect((await getJson<{ reachable: boolean }>(page.request, `/api/cameras/${B}/proxy/info`)).body.reachable).toBe(false);
  expect((await getJson<{ reachable: boolean }>(page.request, `/api/cameras/${A}/proxy/info`)).body.reachable).toBe(true);
  await page.goto(`/app/video?cam=${B}`);
  await expect(page.getByTestId('camera-card-proxy')).toHaveAttribute('data-reachable', 'false', { timeout: 30_000 });
  expect((await page.request.get(`/api/cameras/${B}/still/latest.jpg`)).status()).toBe(502);
  // Camera A: its still, its proxy, its events and notices.
  await page.goto(`/app/video?cam=${A}`);
  await expect(page.getByTestId('camera-card-proxy')).not.toHaveAttribute('data-reachable', 'false');
  await expect(page.getByTestId('live-badge')).toContainText('LIVE', { timeout: 30_000 });
  const latest = await page.request.get(`/api/cameras/${A}/still/latest.jpg`);
  expect(latest.status()).toBe(200);
  const t = Date.now();
  await trigger(A, 'pet', 4);
  await expect.poll(async () => (await notices()).filter((n) => n.t >= t).map((n) => n.text), { timeout: 30_000 }).toContain('Pet on Alpha');
  // The Archive still lists A's clip and says B's proxy didn't answer.
  const list = await getJson<{ items: { name: string }[]; proxies: { via: string; ok: boolean; error?: string }[] }>(page.request, `/api/archive?q=${RUN}`);
  expect(list.body.items.map((x) => x.name)).toEqual([`${RUN} Alpha`]);
  expect(list.body.proxies.find((p) => p.via === B)).toMatchObject({ ok: false, error: 'unreachable' });
  await page.goto('/app/archive');
  await expect(page.getByTestId('archive-proxy-note')).toHaveText('Bravo’s cam-proxy didn’t answer; its clips are missing here.');
});

test('proxy B back: its events flow again, without old notices replayed', async ({ page }) => {
  restartedAt = Date.now();
  execFileSync('bash', [START, '--start-proxy-b'], { stdio: 'inherit' });
  await expect.poll(async () => (await seen()).some((s) => s.t >= restartedAt && s.event === 'proxy' && s.data.cam === B && s.data.up === true), { timeout: 90_000 }).toBe(true);
  expect((await getJson<{ reachable: boolean }>(page.request, `/api/cameras/${B}/proxy/info`)).body.reachable).toBe(true);
  // Settle: whatever cams relays for B now on its own is a replay.
  await new Promise((r) => setTimeout(r, 15_000));
  const replayed = eventsFor(await seen(), B, restartedAt).filter((s) => s.data.type === 'camera-event' && s.data.phase === 'start');
  expect(replayed, 'camera events for B relayed after the restart without a new event').toEqual([]);
  expect((await notices()).filter((n) => n.t >= restartedAt && n.text.endsWith('on Bravo')), 'notices for B after the restart without a new event').toEqual([]);
  // A new event on B comes through, once.
  const t = Date.now();
  await trigger(B, 'person', 4);
  await expect.poll(async () => (await notices()).filter((n) => n.t >= t).map((n) => n.text), { timeout: 30_000 }).toContain('Person on Bravo');
  await expect.poll(async () => eventsFor(await seen(), B, t).filter((s) => s.data.type === 'camera-event' && s.data.kind === 'person' && s.data.phase === 'start').length, { timeout: 30_000 }).toBe(1);
  // And its Archive is back in the merged list.
  const list = await getJson<{ items: { name: string }[] }>(page.request, `/api/archive?q=${RUN}`);
  expect(list.body.items.map((x) => x.name).sort()).toEqual([`${RUN} Alpha`, `${RUN} Bravo`]);
});
