# Analytics in cams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cams shows cam-proxy's Google Vision results: a confidence badge on the event cards ("✦ Vision 84%", "not confirmed", "+ Pet 70%"), and a Timeline rebuilt on cam-proxy's model (a minute opens under its hour, a second opens the large still with Vision's boxes, "Open in History" opens History paused).

**Architecture:** The cams server subscribes to cam-proxy's `analysis` stream messages and keeps them per camera. When a day's events load, it fetches that day's analyses from cam-proxy (`/api/cameras/{cam}/analyses`, cached 60 s today and 1 h for past days), overlays the live ones, and attaches a per-card `analysis` object (best score per category, "not confirmed" categories, analysed stills). Browsers get an `analysis` change on the existing relay and reload the day as they already do. The Timeline page uses the cards' `analysis.stills` for its marks and boxes.

**Tech Stack:** Node 24, TypeScript, Express 5, Svelte 5 (runes), Vitest (projects: node and components/jsdom), Playwright, the fake cam-proxy in `test/proxy/fakeProxy.ts`.

**Spec:** `~/Development/cam-proxy/docs/superpowers/specs/2026-09-30-analytics-in-cams-design.md` (section "cams"). The cam-proxy side is Plan A, `~/Development/cam-proxy/docs/superpowers/plans/2026-09-30-analytics-summary.md`; it defines the message and `/analyses` shapes used here.

## Global Constraints

- The proxy token never reaches a browser; browsers never get the provider's raw answer.
- Vision colour: purple `#a855f7`, as in cam-proxy.
- Matching: an analysis belongs to a card when its event start is in `[card start − 5 s, card end]`.
- Cache: 60 s for today, 1 h for past days; a received message updates it.
- cam-proxy's list routes take at most one day per request.
- A day load waits at most 3 s for cam-proxy's analyses.
- Compatibility: with an older cam-proxy (no `analysis` stream type, no `/analyses`, no `summary`), cams shows no badges and logs only at debug level. The events and the stream keep working.
- No badge when there is no analysis: motion only, the limit was reached, analytics is off, or the camera has no proxy.
- The camera's labels never change.
- No committed media. e2e images come from ffmpeg at start-up (`e2e/fakeProxyData.ts`).
- Stage files explicitly. CHANGELOG entries go under `## [Unreleased]`.

## Review Focus

1. **An analysis that fits two cards.** A clip repeats the previous clip's last seconds, so the 5 s slack can match two cards. It must go to one card only: the latest card that had already started, otherwise the earliest. Tested in Task 1.
2. **An older cam-proxy.**
   - Its stream answers 400 "unknown type: analysis": cams must reconnect without `analysis`, not stay down.
   - Its `/analyses` answers 404: the cards show no badge, and cams doesn't ask again within the TTL.
   - Tested in Tasks 1 and 2.
3. **cam-proxy slow or failing during a day load.** The events still answer, without `analysis`, after at most 3 s. Tested in Task 2 (a 500) and bounded by the client timeout.
4. **A newer record for the same event.** A live message for an event that the day cache also holds, e.g. `skipped` then `ok` after a retry, replaces the cached one. Tested in Task 1.
5. **Bad data from the proxy.** A summary entry with an unknown category, a non-number score or a missing box is dropped, not rendered. Tested in Task 1 (`parseAnalysis`) and Task 5 (zero-area boxes aren't drawn).

## File Structure

**Create**
- `server/proxy/analyses.ts`: the analysis types, `parseAnalysis`, `parseSummary`, `parseObjects`, `dayWindow`, `AnalysisStore` (the live messages plus the day cache) and its stream listener.
- `server/recordings/analysis.ts`: `attachAnalyses` (cards + analyses → cards with `analysis`), a pure function.
- `web/src/lib/vision.ts`: the browser types, `badges()` and `subtypes()`.
- `web/src/components/VisionBadges.svelte`: the badges, used by History's list and Live's recent events.
- `web/src/components/TimelineStill.svelte`: the large still with boxes and "Show all objects".
- Tests:
  - `test/analyses.test.ts`
  - `test/analysesRoutes.test.ts`
  - `web/src/lib/vision.test.ts`
  - `web/src/components/VisionBadges.svelte.test.ts`
  - `web/src/components/TimelineStill.svelte.test.ts`
  - `e2e/vision.spec.ts`

**Modify**
- `server/proxy/client.ts`: `json()` takes `timeoutMs`.
- `server/proxy/stream.ts`: subscribe to `analysis`, with a fallback for older proxies.
- `server/routes/events.ts`: relay `analysis` as a `change`.
- `server/routes/recordings.ts`: attach the analyses to `/events`.
- `server/routes/proxy.ts`: `GET /api/cameras/:id/analyses/:eventId`.
- `test/proxy/fakeProxy.ts`: analyses, the full record, `knownTypes`, and a test hook.
- `e2e/fakeProxyData.ts`: `seed()` returns its media.
- `test/proxyStream.test.ts`
- `web/src/lib/recordings.ts`: `EventClip.analysis`.
- `web/src/components/EventList.svelte`
- `web/src/components/LivePanel.svelte`
- `web/src/lib/timeline.ts`: the minute-view helpers. Test: `web/src/lib/timeline.test.ts`.
- `web/src/pages/Timeline.svelte`: rewritten. Test: `web/src/pages/Timeline.svelte.test.ts`.
- `web/src/components/StripPlayer.svelte`: drop `&grid=1`.
- `e2e/timeline.spec.ts`
- `README.md`
- `CHANGELOG.md`

---

### Task 1: Analyses on the server: parsing, the store, matching to cards

**Files:**
- Create: `server/proxy/analyses.ts`, `server/recordings/analysis.ts`, `test/analyses.test.ts`
- Modify: `server/proxy/client.ts` (`json`), `test/proxy/fakeProxy.ts` (analyses routes, `knownTypes`)

**Interfaces:**
- Produces (`server/proxy/analyses.ts`):
  - `type Category = 'person' | 'vehicle' | 'pet'`, `const CATEGORIES: Category[]`
  - `interface Box { x0: number; y0: number; x1: number; y1: number }`
  - `interface SummaryEntry { category: Category; subtype: string; score: number; box: Box }`
  - `interface StillObject { name: string; score: number; box: Box | null }`
  - `interface ProxyAnalysis { eventId: number; kind: string; start: number; end: number | null; status: string; reason: string | null; stillTs: number | null; summary: SummaryEntry[] }`
  - `parseAnalysis(v: unknown): ProxyAnalysis | null`, `parseSummary(v: unknown): SummaryEntry[]`, `parseObjects(v: unknown): StillObject[]`
  - `dayWindow(date: string, sampleIso: string): [number, number] | null`
  - `class AnalysisStore { ingest(cam, a, now?); forDay(cam, date, events, now?): Promise<ProxyAnalysis[]> }`
  - `getAnalysisStore(): AnalysisStore`, `resetAnalysisStore(): void`
  - Module side effect: a `proxyHub` listener that ingests `analysis` messages.
- Produces (`server/recordings/analysis.ts`):
  - `interface CardAnalysis { best: Partial<Record<Category, { score: number; subtype: string }>>; notConfirmed: Category[]; stills: { eventId: number; stillTs: number; summary: SummaryEntry[] }[] }`
  - `cardFor(cards: { s: number; e: number }[], start: number): number`
  - `attachAnalyses<T extends { start: string; end: string; triggers: readonly string[] }>(cards: T[], analyses: ProxyAnalysis[]): (T & { analysis?: CardAnalysis })[]`
- Produces (`test/proxy/fakeProxy.ts`):
  - `interface FakeAnalysis extends <message shape> { provider: string; objects: { name: string; score: number; box: Box }[] }`
  - `fake.analyses: Map<string, FakeAnalysis[]>` (proxy camera id → list)
  - `fake.analysesStatus: number | null`
  - `fake.knownTypes: string[] | null`
- Produces (`ProxyClient.json`): `json<T>(path, query?, init?: { timeoutMs?: number })`

- [ ] **Step 1: Extend the fake cam-proxy**

In `test/proxy/fakeProxy.ts`:

- after `FakeMessage`, add:

```ts
export interface FakeBox { x0: number; y0: number; x1: number; y1: number }
// An analysis as cam-proxy stores it (spec 2026-09-30-analytics-in-cams-design):
// the stream message's shape, plus the full object list.
export interface FakeAnalysis {
  eventId: number;
  kind: string;
  start: number;
  end: number | null;
  provider: string;
  status: string;
  reason: string | null;
  stillTs: number | null;
  summary: { category: string; subtype: string; score: number; box: FakeBox }[];
  objects: { name: string; score: number; box: FakeBox }[];
}
```

- in `interface FakeProxy`, after `streamStatus`, add:

```ts
  analyses: Map<string, FakeAnalysis[]>; // proxy camera id → its analyses
  analysesStatus: number | null; // tests: /analyses answers this error (404: an older proxy)
  knownTypes: string[] | null; // tests: the stream refuses other types (an older proxy)
```

- in the `fake` object, after `streamStatus: null,`, add `analyses: new Map(), analysesStatus: null, knownTypes: null,`;
- in `app.get('/api/stream', …)`, right after the `streamStatus` line and the `types` constant, add:

```ts
    // Like the real one: an unknown type is refused (a cam-proxy before `analysis` existed).
    const unknown = fake.knownTypes && types?.find((t) => !fake.knownTypes!.includes(t));
    if (unknown) return void res.status(400).json({ error: 'invalid', detail: `unknown type: ${unknown}` });
```

- before `let inFlight = 0;`, add:

```ts
  // The day's analyses and one analysis in full, like cam-proxy's API.
  app.get('/api/cameras/:cam/analyses', (req, res) => {
    if (fake.analysesStatus) return void res.status(fake.analysesStatus).json({ error: 'not_found' });
    const r = range(req.query);
    if (!r) return void res.status(400).json({ error: 'invalid' });
    if (r[1] - r[0] > 86_400_000) return void res.status(400).json({ error: 'invalid', detail: 'at most one day per request' });
    res.json(
      (fake.analyses.get(req.params.cam) ?? [])
        .filter((a) => a.start >= r[0] && a.start <= r[1])
        .sort((a, b) => a.start - b.start)
        .map(({ objects: _objects, ...a }) => a),
    );
  });
  app.get('/api/cameras/:cam/events/:id/analysis', (req, res) => {
    const a = (fake.analyses.get(req.params.cam) ?? []).find((x) => x.eventId === Number(req.params.id));
    if (!a) return void res.status(404).json({ error: 'not_found' });
    res.json({ eventId: a.eventId, provider: a.provider, status: a.status, reason: a.reason, stillTs: a.stillTs, requestedAt: a.start, tookMs: 300, objects: a.objects, summary: a.summary, raw: { secret: 'raw' } });
  });
```

- [ ] **Step 2: Write the failing tests**

Create `test/analyses.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { AnalysisStore, dayWindow, parseAnalysis, parseObjects, type ProxyAnalysis } from '../server/proxy/analyses';
import { attachAnalyses, cardFor } from '../server/recordings/analysis';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

const T = Date.parse('2026-09-30T15:48:20-05:00');
const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };
const person = (score: number, subtype = 'person') => ({ category: 'person' as const, subtype, score, box });
const a = (o: Partial<ProxyAnalysis> = {}): ProxyAnalysis => ({
  eventId: 1, kind: 'person', start: T, end: T + 5000, status: 'ok', reason: null, stillTs: T + 1000, summary: [person(0.84)], ...o,
});
const card = (start: string, end: string, triggers: string[] = ['person']) => ({ id: start, start, end, durationSec: 0, triggers, sizeSub: null, sizeMain: null });
const iso = (ms: number) => new Date(ms - 5 * 3_600_000).toISOString().replace('.000Z', '-05:00');

describe('parseAnalysis', () => {
  it('keeps the message shape, dropping the objects and bad summary entries', () => {
    const got = parseAnalysis({
      ...a(),
      provider: 'google-vision',
      objects: [{ name: 'Ceiling fan', score: 0.9, box }],
      summary: [person(0.84), { category: 'bird', subtype: 'bird', score: 0.9, box }, { category: 'pet', subtype: 'dog', score: 'x', box }, { category: 'pet', subtype: 'dog', score: 0.5 }],
    });
    expect(got).toEqual(a());
  });

  it('refuses an older proxy’s message (no start, no summary)', () => {
    expect(parseAnalysis({ eventId: 1, provider: 'google-vision', status: 'ok', reason: null, objects: [] })).toBeNull();
  });

  it('reads objects, with a null box where the proxy sent none', () => {
    expect(parseObjects([{ name: 'Person', score: 0.8, box }, { name: 'Fan', score: 0.6 }, { name: 3 }])).toEqual([
      { name: 'Person', score: 0.8, box },
      { name: 'Fan', score: 0.6, box: null },
    ]);
  });
});

describe('dayWindow', () => {
  it('is the camera’s day from its offset, 5 s early, one day long', () => {
    const [from, to] = dayWindow('2026-09-30', '2026-09-30T15:48:21-05:00')!;
    expect(from).toBe(Date.parse('2026-09-30T00:00:00-05:00') - 5000);
    expect(to - from).toBe(86_400_000 - 1);
  });

  it('is null for a time without an offset', () => {
    expect(dayWindow('2026-09-30', '2026-09-30T15:48:21')).toBeNull();
  });
});

describe('attachAnalyses', () => {
  const c1 = card(iso(T + 4000), iso(T + 30_000));

  it('attaches an analysis from 5 s before a card to its end, best score per category', () => {
    const [c] = attachAnalyses([c1], [a(), a({ eventId: 2, start: T + 10_000, stillTs: T + 11_000, summary: [person(0.9, 'man')] })]);
    expect(c.analysis).toEqual({
      best: { person: { score: 0.9, subtype: 'man' } },
      notConfirmed: [],
      stills: [
        { eventId: 1, stillTs: T + 1000, summary: [person(0.84)] },
        { eventId: 2, stillTs: T + 11_000, summary: [person(0.9, 'man')] },
      ],
    });
  });

  it('leaves out an analysis more than 5 s before the card', () => {
    const [c] = attachAnalyses([c1], [a({ start: T - 2000 })]);
    expect(c.analysis).toBeUndefined();
  });

  it('gives an analysis that fits two cards to the one that had started', () => {
    // A clip repeats the last seconds of the one before (its pre-record).
    const c2 = card(iso(T + 27_000), iso(T + 50_000));
    expect(cardFor([{ s: T + 4000, e: T + 30_000 }, { s: T + 27_000, e: T + 50_000 }], T + 28_000)).toBe(1);
    expect(cardFor([{ s: T + 4000, e: T + 30_000 }, { s: T + 27_000, e: T + 50_000 }], T + 25_000)).toBe(0);
    const [x, y] = attachAnalyses([c1, c2], [a({ start: T + 28_000 })]);
    expect(x.analysis).toBeUndefined();
    expect(y.analysis?.stills).toHaveLength(1);
  });

  it('says "not confirmed" when an analysis of the camera’s kind found nothing of it', () => {
    const [c] = attachAnalyses([card(iso(T), iso(T + 30_000), ['person', 'motion'])], [a({ summary: [] })]);
    expect(c.analysis).toEqual({ best: {}, notConfirmed: ['person'], stills: [{ eventId: 1, stillTs: T + 1000, summary: [] }] });
  });

  it('does not call a person unconfirmed from an analysis of a motion event', () => {
    const [c] = attachAnalyses([card(iso(T), iso(T + 30_000), ['person', 'motion'])], [a({ kind: 'motion', summary: [] })]);
    expect(c.analysis?.notConfirmed).toEqual([]);
  });

  it('reports an extra finding the camera did not label', () => {
    const [c] = attachAnalyses([card(iso(T), iso(T + 30_000), ['person'])], [a({ summary: [person(0.8), { category: 'pet', subtype: 'dog', score: 0.7, box }] })]);
    expect(c.analysis?.best).toEqual({ person: { score: 0.8, subtype: 'person' }, pet: { score: 0.7, subtype: 'dog' } });
  });

  it('adds nothing when every analysis was skipped or failed', () => {
    const [c] = attachAnalyses([c1], [a({ status: 'skipped', reason: 'limit', stillTs: null, summary: [] }), a({ eventId: 2, status: 'failed', reason: 'timeout' })]);
    expect(c).not.toHaveProperty('analysis');
  });
});

describe('AnalysisStore', () => {
  let fake: FakeProxy;
  const NOW = Date.parse('2026-09-30T16:00:00-05:00');
  const day = [card('2026-09-30T15:48:24-05:00', '2026-09-30T15:48:40-05:00')];
  const asked = () => fake.requests.filter((r) => r.path === '/api/cameras/cam1/analyses').length;

  beforeEach(async () => {
    fake = await startFakeProxy();
    // cams calls it "den"; the proxy knows it as "cam1".
    setCameras([{ id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } }]);
    resetProxyClients();
  });
  afterEach(async () => {
    await fake.stop();
    setCameras([]);
  });

  it('fetches the day from the proxy once, under the proxy’s name for the camera', async () => {
    fake.analyses.set('cam1', [{ ...a(), provider: 'google-vision', objects: [] }]);
    const s = new AnalysisStore();
    expect(await s.forDay('den', '2026-09-30', day, NOW)).toEqual([a()]);
    await s.forDay('den', '2026-09-30', day, NOW + 30_000);
    expect(asked()).toBe(1);
  });

  it('asks again after 60 s for today, and after an hour for a past day', async () => {
    const s = new AnalysisStore();
    await s.forDay('den', '2026-09-30', day, NOW);
    await s.forDay('den', '2026-09-30', day, NOW + 61_000);
    expect(asked()).toBe(2);
    const past = [card('2026-09-29T10:00:00-05:00', '2026-09-29T10:00:20-05:00')];
    await s.forDay('den', '2026-09-29', past, NOW);
    await s.forDay('den', '2026-09-29', past, NOW + 30 * 60_000);
    expect(asked()).toBe(3);
    await s.forDay('den', '2026-09-29', past, NOW + 61 * 60_000);
    expect(asked()).toBe(4);
  });

  it('overlays received messages on the cached day; the newer record wins', async () => {
    fake.analyses.set('cam1', [{ ...a({ status: 'skipped', reason: 'limit', stillTs: null, summary: [] }), provider: 'google-vision', objects: [] }]);
    const s = new AnalysisStore();
    await s.forDay('den', '2026-09-30', day, NOW);
    s.ingest('den', a(), NOW);
    s.ingest('den', a({ eventId: 2, start: T + 60_000 }), NOW);
    const got = await s.forDay('den', '2026-09-30', day, NOW + 1000);
    expect(got.map((x) => [x.eventId, x.status])).toEqual([[1, 'ok'], [2, 'ok']]);
    expect(asked()).toBe(1);
  });

  it('answers with the received messages alone while the proxy is away, and asks again next time', async () => {
    const s = new AnalysisStore();
    s.ingest('den', a(), NOW);
    fake.offline = true;
    expect(await s.forDay('den', '2026-09-30', day, NOW)).toEqual([a()]);
    fake.offline = false;
    await s.forDay('den', '2026-09-30', day, NOW + 1000);
    expect(asked()).toBe(1);
  });

  it('remembers an older proxy without /analyses as an empty day', async () => {
    fake.analysesStatus = 404;
    const s = new AnalysisStore();
    expect(await s.forDay('den', '2026-09-30', day, NOW)).toEqual([]);
    await s.forDay('den', '2026-09-30', day, NOW + 1000);
    expect(asked()).toBe(1);
  });

  it('makes one request for loads of the same day at once', async () => {
    const s = new AnalysisStore();
    await Promise.all([1, 2, 3].map(() => s.forDay('den', '2026-09-30', day, NOW)));
    expect(asked()).toBe(1);
  });

  it('has nothing for a day without cards', async () => {
    expect(await new AnalysisStore().forDay('den', '2026-09-30', [], NOW)).toEqual([]);
    expect(asked()).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/analyses.test.ts`
Expected: FAIL, "Cannot find module '../server/proxy/analyses'" (or '../server/recordings/analysis').

- [ ] **Step 4: Give `ProxyClient.json` a timeout**

In `server/proxy/client.ts`, replace the `json` method's first lines:

```ts
  async json<T>(path: string, query?: Query, init: { timeoutMs?: number } = {}): Promise<T> {
    const res = await this.open(path, query, init);
```

(The rest of the method is unchanged.)

- [ ] **Step 5: Write `server/proxy/analyses.ts`**

```ts
import { logger } from '../logger';
import { getProxyClient, proxyCameraId, ProxyError } from './client';
import { proxyHub } from './stream';

// cam-proxy's Vision results (spec 2026-09-30-analytics-in-cams-design, in
// cam-proxy): the summary only, per camera. Live ones arrive with the
// `analysis` stream message; a day load fetches the rest.

export type Category = 'person' | 'vehicle' | 'pet';
export const CATEGORIES: Category[] = ['person', 'vehicle', 'pet'];
export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface SummaryEntry { category: Category; subtype: string; score: number; box: Box }
export interface StillObject { name: string; score: number; box: Box | null }
export interface ProxyAnalysis {
  eventId: number;
  kind: string;
  start: number;
  end: number | null;
  status: string;
  reason: string | null;
  stillTs: number | null;
  summary: SummaryEntry[];
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const int = (v: unknown): v is number => Number.isSafeInteger(v);

function parseBox(v: unknown): Box | null {
  const b = v as Partial<Box> | null | undefined;
  return b && num(b.x0) && num(b.y0) && num(b.x1) && num(b.y1) ? { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } : null;
}

export function parseSummary(v: unknown): SummaryEntry[] {
  return (Array.isArray(v) ? v : []).flatMap((x) => {
    const e = x as { category?: unknown; subtype?: unknown; score?: unknown; box?: unknown } | null;
    const box = parseBox(e?.box);
    if (!e || !CATEGORIES.includes(e.category as Category) || typeof e.subtype !== 'string' || !num(e.score) || !box) return [];
    return [{ category: e.category as Category, subtype: e.subtype.slice(0, 64), score: e.score, box }];
  });
}

export function parseObjects(v: unknown): StillObject[] {
  return (Array.isArray(v) ? v : []).flatMap((x) => {
    const o = x as { name?: unknown; score?: unknown; box?: unknown } | null;
    if (!o || typeof o.name !== 'string' || !num(o.score)) return [];
    return [{ name: o.name.slice(0, 64), score: o.score, box: parseBox(o.box) }];
  });
}

// One analysis from the proxy, or null for anything else (an older proxy's
// message has no start or summary).
export function parseAnalysis(v: unknown): ProxyAnalysis | null {
  const a = v as Record<string, unknown> | null;
  if (!a || !int(a.eventId) || typeof a.kind !== 'string' || !int(a.start) || typeof a.status !== 'string' || !Array.isArray(a.summary)) return null;
  return {
    eventId: a.eventId,
    kind: a.kind,
    start: a.start,
    end: int(a.end) ? a.end : null,
    status: a.status,
    reason: typeof a.reason === 'string' ? a.reason : null,
    stillTs: int(a.stillTs) ? a.stillTs : null,
    summary: parseSummary(a.summary),
  };
}

const DAY = 86_400_000;
const SLACK_MS = 5000; // an analysis counts for a card from 5 s before it
const RECENT_TTL = 60_000;
const PAST_TTL = 3_600_000;
const LIVE_KEEP_MS = 2 * DAY;
const FETCH_TIMEOUT_MS = 3000;

// The camera's day as [first ms, last ms], from a card's time and its offset:
// 5 s early for the slack, and one day long, the proxy's limit (a 25-hour
// day loses its last hour, a day's last 5 s go to the next day's window).
export function dayWindow(date: string, sampleIso: string): [number, number] | null {
  const off = /([+-]\d{2}:\d{2}|Z)$/.exec(sampleIso)?.[1];
  if (!off) return null;
  const start = Date.parse(`${date}T00:00:00${off}`);
  if (!Number.isFinite(start)) return null;
  return [start - SLACK_MS, start - SLACK_MS + DAY - 1];
}

export class AnalysisStore {
  private live = new Map<string, Map<number, ProxyAnalysis>>(); // cam → eventId → received
  private days = new Map<string, { at: number; list: ProxyAnalysis[] }>(); // `${cam}|${date}`
  private inflight = new Map<string, Promise<ProxyAnalysis[]>>();

  ingest(cam: string, a: ProxyAnalysis, now = Date.now()): void {
    let m = this.live.get(cam);
    if (!m) this.live.set(cam, (m = new Map()));
    m.set(a.eventId, a);
    for (const [id, x] of m) if (x.start < now - LIVE_KEEP_MS) m.delete(id);
  }

  // The analyses for a camera's day of cards, oldest first: the fetched day
  // (cached), with received messages over it. Never throws: while the proxy
  // fails, the received ones only.
  async forDay(cam: string, date: string, events: { start: string; end: string }[], now = Date.now()): Promise<ProxyAnalysis[]> {
    if (!events.length) return [];
    const win = dayWindow(date, events[0].start);
    if (!win) return [];
    for (const [k, d] of this.days) if (now - d.at >= PAST_TTL) this.days.delete(k);
    const key = `${cam}|${date}`;
    const ttl = now <= win[1] ? RECENT_TTL : PAST_TTL;
    const hit = this.days.get(key);
    const list = hit && now - hit.at < ttl ? hit.list : await (this.inflight.get(key) ?? this.fetch(cam, key, win, now));
    const byId = new Map(list.map((a) => [a.eventId, a]));
    for (const a of this.live.get(cam)?.values() ?? []) if (a.start >= win[0] && a.start <= win[1]) byId.set(a.eventId, a);
    return [...byId.values()].sort((a, b) => a.start - b.start || a.eventId - b.eventId);
  }

  private fetch(cam: string, key: string, win: [number, number], now: number): Promise<ProxyAnalysis[]> {
    const work = (async () => {
      const client = getProxyClient(cam);
      if (!client) return [];
      try {
        const body = await client.json<unknown>(`/api/cameras/${encodeURIComponent(proxyCameraId(cam))}/analyses`, { from: win[0], to: win[1] }, { timeoutMs: FETCH_TIMEOUT_MS });
        const list = (Array.isArray(body) ? body : []).map(parseAnalysis).filter((a): a is ProxyAnalysis => a !== null);
        this.days.set(key, { at: now, list });
        return list;
      } catch (err) {
        // An older proxy has no /analyses (404): no badges, remembered like an empty day.
        const status = err instanceof ProxyError ? err.status : undefined;
        if (status === 404) this.days.set(key, { at: now, list: [] });
        logger.debug({ cameraId: cam, code: err instanceof ProxyError ? err.code : 'error', status }, 'proxy_analyses_unavailable');
        return [];
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }
}

let store = new AnalysisStore();
export const getAnalysisStore = (): AnalysisStore => store;
export function resetAnalysisStore(): void {
  store = new AnalysisStore();
}

// Every camera's `analysis` messages, as they arrive.
proxyHub.on('message', (m: { cam: string; type: string; data: unknown }) => {
  if (m.type !== 'analysis') return;
  const a = parseAnalysis(m.data);
  if (a) store.ingest(m.cam, a);
});
```

- [ ] **Step 6: Write `server/recordings/analysis.ts`**

```ts
import { CATEGORIES, type Category, type ProxyAnalysis, type SummaryEntry } from '../proxy/analyses';

// Vision's word on a card (spec 2026-09-30-analytics-in-cams-design): the best
// score per category over the card's ok analyses, the camera's AI labels that
// an analysis of that kind did not find, and the analysed stills.
export interface CardAnalysis {
  best: Partial<Record<Category, { score: number; subtype: string }>>;
  notConfirmed: Category[];
  stills: { eventId: number; stillTs: number; summary: SummaryEntry[] }[];
}

const SLACK_MS = 5000;

// The card an analysis belongs to: its event starts in [card start − 5 s,
// card end]. Where two cards fit (a clip repeats the previous one's last
// seconds), the latest one that had already started wins, else the earliest.
export function cardFor(cards: { s: number; e: number }[], start: number): number {
  const hits = cards.map((c, i) => ({ ...c, i })).filter((c) => start >= c.s - SLACK_MS && start <= c.e);
  const started = hits.filter((c) => c.s <= start);
  if (started.length) return started.reduce((x, y) => (y.s > x.s ? y : x)).i;
  return hits.length ? hits.reduce((x, y) => (y.s < x.s ? y : x)).i : -1;
}

export function attachAnalyses<T extends { start: string; end: string; triggers: readonly string[] }>(cards: T[], analyses: ProxyAnalysis[]): (T & { analysis?: CardAnalysis })[] {
  const spans = cards.map((c) => ({ s: Date.parse(c.start), e: Date.parse(c.end) }));
  const per = cards.map(() => [] as ProxyAnalysis[]);
  for (const a of analyses) {
    if (a.status !== 'ok') continue;
    const i = cardFor(spans, a.start);
    if (i >= 0) per[i].push(a);
  }
  return cards.map((c, i) => {
    const list = per[i];
    if (!list.length) return c;
    const best: CardAnalysis['best'] = {};
    for (const a of list) {
      for (const s of a.summary) {
        const b = best[s.category];
        if (!b || s.score > b.score) best[s.category] = { score: s.score, subtype: s.subtype };
      }
    }
    const notConfirmed = CATEGORIES.filter((k) => c.triggers.includes(k) && !best[k] && list.some((a) => a.kind === k));
    const stills = list.filter((a) => a.stillTs !== null).map((a) => ({ eventId: a.eventId, stillTs: a.stillTs as number, summary: a.summary }));
    return { ...c, analysis: { best, notConfirmed, stills } };
  });
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/analyses.test.ts`
Expected: PASS, all tests.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/proxy/analyses.ts server/recordings/analysis.ts server/proxy/client.ts test/proxy/fakeProxy.ts test/analyses.test.ts
git commit -m "feat: keep cam-proxy's analyses per camera and match them to cards"
```

---

### Task 2: Wiring: the stream, the relay, the events route, one analysis in full

**Files:**
- Modify: `server/proxy/stream.ts`, `server/routes/events.ts`, `server/routes/recordings.ts`, `server/routes/proxy.ts`, `test/proxyStream.test.ts`
- Create: `test/analysesRoutes.test.ts`

**Interfaces:**
- Consumes: from Task 1, `getAnalysisStore()`, `resetAnalysisStore()`, `attachAnalyses()`, `parseSummary()`, `parseObjects()`, and the fake's `analyses`, `analysesStatus` and `knownTypes`.
- Produces:
  - `GET /api/cameras/:id/events?date=`: each event may carry `analysis: CardAnalysis`.
  - `GET /api/cameras/:id/analyses/:eventId` → `{ eventId, status, stillTs, summary, objects }`. Errors: 400 `invalid`, 404 `unknown_camera` / `no_proxy` / `not_found`, 502 `proxy_unavailable`.
  - The browser relay sends `event: change` with `{ cam, type: 'analysis', ts: <event start> }`.

- [ ] **Step 1: Write the failing stream tests**

In `test/proxyStream.test.ts`:

- add to the imports: `import { getAnalysisStore, resetAnalysisStore } from '../server/proxy/analyses';`
- inside `describe('ProxyStream (upstream)', …)`, add:

```ts
  it('asks for analyses too', async () => {
    const fake = await fakeProxy();
    const { s, got } = stream(fake);
    await until(() => s.up());
    fake.push({ cam: 'den', type: 'analysis', data: { eventId: 5, kind: 'person', start: 1000, summary: [] } });
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ type: 'analysis', data: { eventId: 5 } });
  });

  it('asks again without analyses when an older proxy refuses the type', async () => {
    const fake = await fakeProxy();
    fake.knownTypes = ['camera-event', 'camera-status', 'clip'];
    const { s, got } = stream(fake);
    await until(() => s.up());
    fake.push({ cam: 'den', type: 'camera-event', data: { eventId: 1, kind: 'person', phase: 'start', ts: 1000 } });
    await until(() => got.length === 1);
    expect(got[0].type).toBe('camera-event');
  });
```

- inside `describe('GET /api/events/stream (to browsers)', …)`, add:

```ts
  it('tells browsers about a new analysis, and keeps it for the day’s cards', async () => {
    resetAnalysisStore();
    const fake = await fakeProxy();
    const base = await app(fake);
    const c = open(base, auth);
    await until(() => c.frames.some((f) => f.includes('event: proxy') && f.includes('"up":true')));
    const start = Date.parse('2026-09-30T15:48:20-05:00');
    fake.push({ cam: 'den', type: 'analysis', data: { eventId: 9, kind: 'person', start, end: null, provider: 'google-vision', status: 'ok', reason: null, stillTs: start + 1000, summary: [], objects: [{ name: 'Fan', score: 0.9 }] } });
    await until(() => c.frames.some((f) => f.startsWith('event: change')));
    const change = c.frames.find((f) => f.startsWith('event: change'))!;
    expect(JSON.parse(change.split('data: ')[1])).toEqual({ cam: 'den', type: 'analysis', ts: start });
    expect(c.frames.join('\n')).not.toContain('Fan'); // the objects stay on the server
    const got = await getAnalysisStore().forDay('den', '2026-09-30', [{ start: '2026-09-30T15:48:24-05:00', end: '2026-09-30T15:48:40-05:00' }], start);
    expect(got.map((x) => x.eventId)).toEqual([9]);
  });
```

- [ ] **Step 2: Write the failing route tests**

Create `test/analysesRoutes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetProxyClients } from '../server/proxy/client';
import { resetAnalysisStore } from '../server/proxy/analyses';
import { getRecordings, type EventClip } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { FAKE_TOKEN, startFakeProxy, type FakeAnalysis, type FakeProxy } from './proxy/fakeProxy';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const T = Date.parse('2026-09-30T15:48:20-05:00');
const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };
const analysis = (o: Partial<FakeAnalysis> = {}): FakeAnalysis => ({
  eventId: 7, kind: 'person', start: T, end: T + 5000, provider: 'google-vision', status: 'ok', reason: null, stillTs: T + 1000,
  summary: [{ category: 'person', subtype: 'person', score: 0.84, box }],
  objects: [{ name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.7, box }],
  ...o,
});
const card: EventClip = { id: '20260930154824', start: '2026-09-30T15:48:24-05:00', end: '2026-09-30T15:48:40-05:00', durationSec: 16, triggers: ['person'], sizeSub: 1, sizeMain: 1 };
let fake: FakeProxy;

beforeEach(async () => {
  fake = await startFakeProxy();
  setCameras([
    { id: 'den', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: 'cam1' } },
    { id: 'shed', name: 'Shed', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetProxyClients();
  resetAnalysisStore();
  vi.spyOn(getRecordings(), 'events').mockResolvedValue([card]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake.stop();
  setCameras([]);
});

const get = (path: string) => request(createApp()).get(path).set('Cookie', auth);

describe('analyses on the events', () => {
  it('attach to the cards of a camera with a proxy', async () => {
    fake.analyses.set('cam1', [analysis()]);
    const r = await get('/api/cameras/den/events?date=2026-09-30');
    expect(r.status).toBe(200);
    expect(r.body.events[0].analysis).toEqual({
      best: { person: { score: 0.84, subtype: 'person' } },
      notConfirmed: [],
      stills: [{ eventId: 7, stillTs: T + 1000, summary: [{ category: 'person', subtype: 'person', score: 0.84, box }] }],
    });
  });

  it('leave the cards as they are when the proxy fails', async () => {
    fake.analysesStatus = 500;
    const r = await get('/api/cameras/den/events?date=2026-09-30');
    expect(r.status).toBe(200);
    expect(r.body.events[0]).not.toHaveProperty('analysis');
  });

  it('are not asked for a camera without a proxy', async () => {
    const r = await get('/api/cameras/shed/events?date=2026-09-30');
    expect(r.status).toBe(200);
    expect(r.body.events[0]).not.toHaveProperty('analysis');
    expect(fake.requests.some((x) => x.path.endsWith('/analyses'))).toBe(false);
  });
});

describe('GET /api/cameras/:id/analyses/:eventId', () => {
  it('needs a signed-in user', async () => {
    expect((await request(createApp()).get('/api/cameras/den/analyses/7')).status).toBe(401);
  });

  it('answers one analysis in full, without the raw answer', async () => {
    fake.analyses.set('cam1', [analysis()]);
    const r = await get('/api/cameras/den/analyses/7');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      eventId: 7, status: 'ok', stillTs: T + 1000,
      summary: [{ category: 'person', subtype: 'person', score: 0.84, box }],
      objects: [{ name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.7, box }],
    });
    expect(JSON.stringify(r.body)).not.toContain('raw');
    expect(fake.requests.at(-1)?.path).toBe('/api/cameras/cam1/events/7/analysis');
  });

  it('says not found, refuses a bad id, and needs a proxy', async () => {
    expect((await get('/api/cameras/den/analyses/8')).status).toBe(404);
    expect((await get('/api/cameras/den/analyses/x')).status).toBe(400);
    expect((await get('/api/cameras/shed/analyses/7')).body).toEqual({ error: 'no_proxy' });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/proxyStream.test.ts test/analysesRoutes.test.ts`
Expected: FAIL. "asks for analyses too" times out, because the stream doesn't ask for `analysis`. The relay test finds no change. The route tests get no `analysis` and a 404 for `/analyses/7`.

- [ ] **Step 4: Subscribe to `analysis`, with a fallback**

In `server/proxy/stream.ts`:

- replace `const TYPES = 'camera-event,camera-status,clip';` with:

```ts
// `analysis` since cam-proxy v2026.10 (Vision's summary); an older proxy
// refuses the type, and the stream asks again without it.
const TYPES = ['camera-event', 'camera-status', 'clip', 'analysis'];
```

- in `class ProxyStream`, after `private error: string | null = null;`, add `private types = [...TYPES];`;
- in `connect()`, replace the `open` call and the `!res.ok` block with:

```ts
      const res = await this.client.open('/api/stream', { types: this.types.join(','), since: this.lastId }, { signal: abort.signal, idleMs: this.o.idleMs ?? 45_000 });
      if (!res.ok || !res.body) {
        let text = '';
        if (res.status === 400) text = await res.text().catch(() => '');
        else await res.body?.cancel();
        if (this.types.includes('analysis') && /unknown type: analysis/.test(text)) {
          this.types = this.types.filter((t) => t !== 'analysis');
          logger.debug({ cameraId: this.cam }, 'proxy_stream_without_analysis');
          return void this.connect();
        }
        throw new ProxyError('proxy_error', `cam-proxy ${this.client.host()} stream answered ${res.status}`, res.status);
      }
```

- [ ] **Step 5: Relay `analysis` to browsers**

In `server/routes/events.ts`, in `onMessage`, change the condition to:

```ts
    if (m.type === 'camera-event' || m.type === 'clip' || m.type === 'reset' || m.type === 'camera-status' || m.type === 'analysis') {
```

- Add above it: `// A new analysis (Vision): pages reload the day, and its cards get their badge.`
- `tsOf` already reads `data.start`, which is the analysed event's start.
- The recordings invalidation handler above stays as it is: an analysis doesn't change the recordings.

- [ ] **Step 6: Attach the analyses to `/events`**

In `server/routes/recordings.ts`:

- add the imports:

```ts
import { getProxyClient } from '../proxy/client';
import { getAnalysisStore } from '../proxy/analyses';
import { attachAnalyses } from '../recordings/analysis';
```

- in the `/api/cameras/:id/events` handler, replace `res.json({ date, events, downloads: rec.downloadsState(id) });` with:

```ts
    // cam-proxy's Vision results on the cards (spec 2026-09-30-analytics-in-cams-design).
    const shown = getProxyClient(id) ? attachAnalyses(events, await getAnalysisStore().forDay(id, date, events)) : events;
    res.json({ date, events: shown, downloads: rec.downloadsState(id) });
```

- [ ] **Step 7: Serve one analysis in full**

In `server/routes/proxy.ts`:

- add the import `import { parseObjects, parseSummary } from '../proxy/analyses';`
- after the `stills` list route, add:

```ts
// One analysis in full, for the Timeline's "Show all objects": the summary
// and every object, never the provider's raw answer.
proxyRouter.get('/api/cameras/:id/analyses/:eventId', async (req: Request, res: Response) => {
  if (!/^\d{1,12}$/.test(String(req.params.eventId))) return bad(res, 'an event id is a number');
  const p = proxied(req, res);
  if (!p) return;
  const eventId = Number(req.params.eventId);
  try {
    const a = await p.client.json<{ status?: unknown; stillTs?: unknown; summary?: unknown; objects?: unknown }>(`/api/cameras/${p.cam}/events/${eventId}/analysis`);
    res.json({
      eventId,
      status: typeof a.status === 'string' ? a.status : 'unknown',
      stillTs: Number.isSafeInteger(a.stillTs) ? a.stillTs : null,
      summary: parseSummary(a.summary),
      objects: parseObjects(a.objects),
    });
  } catch (err) {
    if (err instanceof ProxyError && err.status === 404 && !res.headersSent) return void res.status(404).json({ error: 'not_found' });
    proxyFailed(err, String(req.params.id), res);
  }
});
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/proxyStream.test.ts test/analysesRoutes.test.ts test/proxyRoutes.test.ts test/recordingsRoutes.test.ts`
Expected: PASS, all tests.

Run: `npm test`
Expected: PASS, the whole suite.

- [ ] **Step 9: Commit**

```bash
git add server/proxy/stream.ts server/routes/events.ts server/routes/recordings.ts server/routes/proxy.ts test/proxyStream.test.ts test/analysesRoutes.test.ts
git commit -m "feat: Vision results on the events, the analysis stream, and one analysis in full"
```

---

### Task 3: The badges on the event cards

**Files:**
- Create: `web/src/lib/vision.ts`, `web/src/lib/vision.test.ts`, `web/src/components/VisionBadges.svelte`, `web/src/components/VisionBadges.svelte.test.ts`
- Modify: `web/src/lib/recordings.ts` (`EventClip`), `web/src/components/EventList.svelte`, `web/src/components/LivePanel.svelte`

**Interfaces:**
- Consumes: the `analysis` object from Task 2's events response.
- Produces (`web/src/lib/vision.ts`):
  - `type Category`
  - `interface Box`
  - `interface SummaryEntry`
  - `interface StillObject { name: string; score: number; box: Box | null }`
  - `interface CardAnalysis` (the same shape as the server's)
  - `interface Badge { kind: 'agree' | 'not-confirmed' | 'extra'; category: Category; text: string; title: string }`
  - `badges(triggers: readonly string[], a: CardAnalysis | undefined): Badge[]`
  - `subtypes(a: CardAnalysis, k: Category): string`
- Produces: `VisionBadges.svelte` with props `{ triggers: readonly string[]; analysis?: CardAnalysis }`, rendering `[data-testid="vision-badge"][data-kind]`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/vision.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { badges, subtypes, type CardAnalysis } from './vision';

const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };
const an = (o: Partial<CardAnalysis> = {}): CardAnalysis => ({ best: {}, notConfirmed: [], stills: [], ...o });

describe('badges', () => {
  it('confirms a camera label with Vision’s score, and names the subtype in the tooltip', () => {
    const a = an({ best: { person: { score: 0.784, subtype: 'person' } }, stills: [{ eventId: 1, stillTs: 1, summary: [{ category: 'person', subtype: 'person', score: 0.784, box }] }] });
    expect(badges(['person', 'motion'], a)).toEqual([{ kind: 'agree', category: 'person', text: '✦ Vision 78%', title: 'Vision: person 0.78' }]);
  });

  it('says "not confirmed", keeping the camera’s label', () => {
    expect(badges(['person'], an({ notConfirmed: ['person'] }))).toEqual([
      { kind: 'not-confirmed', category: 'person', text: '✦ Vision: not confirmed', title: 'Vision found no person in the analysed still' },
    ]);
  });

  it('adds what Vision found and the camera did not label', () => {
    const a = an({ best: { pet: { score: 0.7, subtype: 'dog' } }, stills: [{ eventId: 1, stillTs: 1, summary: [{ category: 'pet', subtype: 'dog', score: 0.7, box }, { category: 'pet', subtype: 'cat', score: 0.55, box }] }] });
    expect(badges(['motion'], a)).toEqual([{ kind: 'extra', category: 'pet', text: '+ Pet 70%', title: 'Vision: dog 0.70, cat 0.55' }]);
  });

  it('shows nothing without an analysis, or when nothing was found or missed', () => {
    expect(badges(['person'], undefined)).toEqual([]);
    expect(badges(['motion'], an())).toEqual([]);
  });
});

describe('subtypes', () => {
  it('lists each subtype once with its best score, best first', () => {
    const s = (subtype: string, score: number) => ({ category: 'pet' as const, subtype, score, box });
    const a = an({ stills: [{ eventId: 1, stillTs: 1, summary: [s('cat', 0.5), s('dog', 0.6)] }, { eventId: 2, stillTs: 2, summary: [s('cat', 0.9)] }] });
    expect(subtypes(a, 'pet')).toBe('cat 0.90, dog 0.60');
  });
});
```

Create `web/src/components/VisionBadges.svelte.test.ts`:

```ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import VisionBadges from './VisionBadges.svelte';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
});

function render(props: Record<string, unknown>) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(VisionBadges, { target, props });
  flushSync();
  return [...target.querySelectorAll('[data-testid="vision-badge"]')].map((b) => ({ kind: b.getAttribute('data-kind'), text: b.textContent, title: b.getAttribute('title') }));
}

describe('VisionBadges', () => {
  it('renders the agreement and the extra finding', () => {
    const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
    const got = render({
      triggers: ['person'],
      analysis: { best: { person: { score: 0.84, subtype: 'person' }, pet: { score: 0.7, subtype: 'dog' } }, notConfirmed: [], stills: [{ eventId: 1, stillTs: 1, summary: [{ category: 'person', subtype: 'person', score: 0.84, box }, { category: 'pet', subtype: 'dog', score: 0.7, box }] }] },
    });
    expect(got).toEqual([
      { kind: 'agree', text: '✦ Vision 84%', title: 'Vision: person 0.84' },
      { kind: 'extra', text: '+ Pet 70%', title: 'Vision: dog 0.70' },
    ]);
  });

  it('renders nothing without an analysis', () => {
    expect(render({ triggers: ['person'] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/lib/vision.test.ts web/src/components/VisionBadges.svelte.test.ts`
Expected: FAIL, "Cannot find module './vision'" (and './VisionBadges.svelte').

- [ ] **Step 3: Write `web/src/lib/vision.ts`**

```ts
// cam-proxy's Vision results as cams shows them (spec
// 2026-09-30-analytics-in-cams-design): a badge per category on a card.
// The camera's labels stay as they are; Vision adds its confidence.

export type Category = 'person' | 'vehicle' | 'pet';
export const CATEGORIES: Category[] = ['person', 'vehicle', 'pet'];
export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface SummaryEntry { category: Category; subtype: string; score: number; box: Box }
export interface StillObject { name: string; score: number; box: Box | null }
export interface CardAnalysis {
  best: Partial<Record<Category, { score: number; subtype: string }>>;
  notConfirmed: Category[];
  stills: { eventId: number; stillTs: number; summary: SummaryEntry[] }[];
}
export interface Badge { kind: 'agree' | 'not-confirmed' | 'extra'; category: Category; text: string; title: string }

const LABEL: Record<Category, string> = { person: 'Person', vehicle: 'Vehicle', pet: 'Pet' };
const pct = (s: number) => `${Math.round(s * 100)}%`;

// Every subtype Vision saw for a category, each once with its best score,
// best first: "dog 0.70, cat 0.55".
export function subtypes(a: CardAnalysis, k: Category): string {
  const best = new Map<string, number>();
  for (const s of a.stills) for (const e of s.summary) if (e.category === k && e.score > (best.get(e.subtype) ?? -1)) best.set(e.subtype, e.score);
  return [...best].sort((x, y) => y[1] - x[1]).map(([n, v]) => `${n} ${v.toFixed(2)}`).join(', ');
}

// Per category: Vision agrees with the camera's label (its score), found none
// where the camera said so ("not confirmed"), or found one the camera did not
// label ("+ Pet 70%").
export function badges(triggers: readonly string[], a: CardAnalysis | undefined): Badge[] {
  if (!a) return [];
  const out: Badge[] = [];
  for (const k of CATEGORIES) {
    const b = a.best[k];
    if (b && triggers.includes(k)) out.push({ kind: 'agree', category: k, text: `✦ Vision ${pct(b.score)}`, title: `Vision: ${subtypes(a, k)}` });
    else if (a.notConfirmed.includes(k)) out.push({ kind: 'not-confirmed', category: k, text: '✦ Vision: not confirmed', title: `Vision found no ${k} in the analysed still` });
    else if (b) out.push({ kind: 'extra', category: k, text: `+ ${LABEL[k]} ${pct(b.score)}`, title: `Vision: ${subtypes(a, k)}` });
  }
  return out;
}
```

- [ ] **Step 4: Write `web/src/components/VisionBadges.svelte`**

```svelte
<script lang="ts">
  import { badges, type CardAnalysis } from '../lib/vision';

  // Vision's word on a card: History's list and Live's recent events.
  let { triggers, analysis }: { triggers: readonly string[]; analysis?: CardAnalysis } = $props();
  const list = $derived(badges(triggers, analysis));
</script>

{#each list as b (b.kind + b.category)}<span class="vision {b.kind}" title={b.title} data-testid="vision-badge" data-kind={b.kind}>{b.text}</span>{/each}

<style>
  .vision { font-size: 10px; padding: 0 7px; border-radius: 999px; border: 1px solid #a855f7; color: #a855f7; white-space: nowrap; line-height: 1.6; }
  .vision.not-confirmed, .vision.extra { border-style: dashed; border-color: var(--muted); color: var(--muted); }
</style>
```

- [ ] **Step 5: Show the badges on the cards**

`web/src/lib/recordings.ts`:

- add at the top: `import type { CardAnalysis } from './vision';`
- in `interface EventClip`, after `sizeMain`, add `analysis?: CardAnalysis; // cam-proxy's Vision results, when it analysed this recording`.

`web/src/components/EventList.svelte`:

- import `VisionBadges from './VisionBadges.svelte'`;
- in the card's `<span class="tags">`, after the `{#each e.triggers …}` block, add `<VisionBadges triggers={e.triggers} analysis={e.analysis} />`.

`web/src/components/LivePanel.svelte`:

- import `VisionBadges from './VisionBadges.svelte'`;
- in the recent-event row, right after `<strong>{e.triggers.map(…).join(', ') || 'Recording'}</strong>`, add `<span class="badges"><VisionBadges triggers={e.triggers} analysis={e.analysis} /></span>`;
- add the style `.badges { display: flex; gap: 4px; flex-wrap: wrap; }`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run web/src/lib/vision.test.ts web/src/components/VisionBadges.svelte.test.ts web/src/components/LivePanel.svelte.test.ts`
Expected: PASS.

Run: `npm run check && npm run check:svelte`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/vision.ts web/src/lib/vision.test.ts web/src/components/VisionBadges.svelte web/src/components/VisionBadges.svelte.test.ts web/src/lib/recordings.ts web/src/components/EventList.svelte web/src/components/LivePanel.svelte
git commit -m "feat: Vision badges on the event cards"
```

---

### Task 4: The Timeline's minute-view helpers

**Files:**
- Modify: `web/src/lib/timeline.ts`, `web/src/lib/timeline.test.ts`

**Interfaces:**
- Consumes: `SummaryEntry` from `web/src/lib/vision.ts` (Task 3).
- Produces (appended to `web/src/lib/timeline.ts`):
  - `interface SeenStill { eventId: number; stillTs: number; summary: SummaryEntry[] }`
  - `interface TimelineCard { id: string; start: string; end: string; triggers: string[]; analysis?: { stills: SeenStill[] } }`
  - `stepMinute(hour: { minute: number }[], current: number, dir: -1 | 1): number | null`
  - `cardsInMinute<T extends { start: string; end: string }>(m: { minute: number }, cards: T[]): T[]`
  - `cardKind(c: { triggers: readonly string[] }): string`
  - `secondKinds(m: { minute: number; intervalS: number; present: boolean[] }, cards: { start: string; end: string; triggers: readonly string[] }[]): (string | null)[]`
  - `seenStills(cards: TimelineCard[]): SeenStill[]`
  - `minuteMarks(m: { minute: number }, cards: TimelineCard[]): { count: number; analysed: boolean }`
  - `analysedSeconds(m: { minute: number; intervalS: number; present: boolean[] }, cards: TimelineCard[]): (SeenStill | null)[]`

- [ ] **Step 1: Write the failing tests**

Append to `web/src/lib/timeline.test.ts` (add the new names to its import from `./timeline`):

```ts
describe('the minute view (spec 2026-09-30-analytics-in-cams-design)', () => {
  const M = Date.UTC(2026, 8, 30, 20, 48); // a minute
  const iso = (ms: number) => new Date(ms).toISOString();
  const minute = { minute: M, intervalS: 1, present: Array(60).fill(true) as boolean[] };
  const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
  const card = (s: number, e: number, triggers: string[], stills: { eventId: number; stillTs: number; n: number }[] = []) => ({
    id: String(s), start: iso(s), end: iso(e), triggers,
    analysis: stills.length ? { stills: stills.map((x) => ({ eventId: x.eventId, stillTs: x.stillTs, summary: Array(x.n).fill({ category: 'person', subtype: 'person', score: 0.8, box }) })) } : undefined,
  });

  it('steps to the neighbouring minute of the same hour only', () => {
    const hour = [{ minute: M }, { minute: M + 60_000 }];
    expect(stepMinute(hour, M, 1)).toBe(M + 60_000);
    expect(stepMinute(hour, M + 60_000, 1)).toBeNull();
    expect(stepMinute(hour, M, -1)).toBeNull();
  });

  it('lists the cards that overlap a minute, by start', () => {
    const a = card(M + 30_000, M + 90_000, ['motion']);
    const b = card(M - 30_000, M + 5000, ['person']);
    const c = card(M + 61_000, M + 70_000, ['pet']);
    expect(cardsInMinute(minute, [a, b, c])).toEqual([b, a]);
  });

  it('colours a card by its most specific trigger', () => {
    expect(cardKind({ triggers: ['motion', 'person'] })).toBe('person');
    expect(cardKind({ triggers: [] })).toBe('motion');
  });

  it('colours each second by the most specific card covering it', () => {
    const k = secondKinds(minute, [card(M, M + 10_000, ['motion']), card(M + 5000, M + 7000, ['vehicle'])]);
    expect(k[0]).toBe('motion');
    expect(k[6]).toBe('vehicle');
    expect(k[20]).toBeNull();
  });

  it('marks a minute with its card count and with a still that found something', () => {
    const found = card(M, M + 30_000, ['person'], [{ eventId: 1, stillTs: M + 20_000, n: 1 }]);
    const nothing = card(M + 40_000, M + 50_000, ['person'], [{ eventId: 2, stillTs: M + 41_000, n: 0 }]);
    expect(minuteMarks(minute, [found, nothing])).toEqual({ count: 2, analysed: true });
    expect(minuteMarks(minute, [nothing])).toEqual({ count: 1, analysed: false });
    expect(minuteMarks({ minute: M + 60_000 }, [found])).toEqual({ count: 0, analysed: false }); // the still's minute only
  });

  it('finds the analysed still of each second', () => {
    const s = analysedSeconds(minute, [card(M, M + 30_000, ['person'], [{ eventId: 7, stillTs: M + 20_000, n: 1 }])]);
    expect(s[20]).toMatchObject({ eventId: 7, stillTs: M + 20_000 });
    expect(s.filter((x) => x !== null)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/lib/timeline.test.ts`
Expected: FAIL. The new names are not exported (`stepMinute is not a function`, or a TypeScript import error).

- [ ] **Step 3: Implement the helpers**

Append to `web/src/lib/timeline.ts` (add `import type { SummaryEntry } from './vision';` at the top):

```ts
// The minute view (spec 2026-09-30-analytics-in-cams-design, cam-proxy's
// model): a minute opens under its hour, steps ◀ ▶ within that hour, and
// marks its seconds by the cards (recordings) and Vision's analysed stills.
export interface SeenStill { eventId: number; stillTs: number; summary: SummaryEntry[] }
export interface TimelineCard { id: string; start: string; end: string; triggers: string[]; analysis?: { stills: SeenStill[] } }

const MINUTE = 60_000;
const spanOf = (c: { start: string; end: string }) => [Date.parse(c.start), Date.parse(c.end)] as const;

// The neighbouring minute of the same hour, or null at the hour's first or
// last one (no crossing into another hour).
export function stepMinute(hour: { minute: number }[], current: number, dir: -1 | 1): number | null {
  const i = hour.findIndex((m) => m.minute === current);
  if (i < 0) return null;
  return hour[i + dir]?.minute ?? null;
}

export function cardsInMinute<T extends { start: string; end: string }>(m: { minute: number }, cards: T[]): T[] {
  return cards
    .filter((c) => {
      const [s, e] = spanOf(c);
      return s < m.minute + MINUTE && e >= m.minute;
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

const PRIORITY = ['person', 'vehicle', 'pet', 'motion', 'timer'];
const rank = (k: string) => {
  const i = PRIORITY.indexOf(k);
  return i < 0 ? PRIORITY.length : i;
};

// A card's colour: its most specific trigger (person before vehicle, pet, motion).
export function cardKind(c: { triggers: readonly string[] }): string {
  return [...c.triggers].sort((a, b) => rank(a) - rank(b))[0] ?? 'motion';
}

export function secondKinds(m: { minute: number; intervalS: number; present: boolean[] }, cards: { start: string; end: string; triggers: readonly string[] }[]): (string | null)[] {
  const list = cardsInMinute(m, cards);
  return m.present.map((_, i) => {
    const from = m.minute + i * m.intervalS * 1000;
    const to = from + m.intervalS * 1000 - 1;
    let best: string | null = null;
    for (const c of list) {
      const [s, e] = spanOf(c);
      const k = cardKind(c);
      if (s <= to && e >= from && (best === null || rank(k) < rank(best))) best = k;
    }
    return best;
  });
}

// Vision's analysed stills that found something (a non-empty summary).
export function seenStills(cards: TimelineCard[]): SeenStill[] {
  return cards.flatMap((c) => c.analysis?.stills.filter((s) => s.summary.length > 0) ?? []);
}

// The hour grid's marks for a minute: how many cards it has (×2, ×3), and
// whether a still in it found something (purple).
export function minuteMarks(m: { minute: number }, cards: TimelineCard[]): { count: number; analysed: boolean } {
  return {
    count: cardsInMinute(m, cards).length,
    analysed: seenStills(cards).some((s) => s.stillTs >= m.minute && s.stillTs < m.minute + MINUTE),
  };
}

// Per tile of the minute, the analysed still in that second, or null.
export function analysedSeconds(m: { minute: number; intervalS: number; present: boolean[] }, cards: TimelineCard[]): (SeenStill | null)[] {
  const stills = seenStills(cards);
  return m.present.map((_, i) => {
    const from = m.minute + i * m.intervalS * 1000;
    return stills.find((s) => s.stillTs >= from && s.stillTs < from + m.intervalS * 1000) ?? null;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web/src/lib/timeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/timeline.ts web/src/lib/timeline.test.ts
git commit -m "feat: Timeline helpers for the minute view and Vision's marks"
```

---

### Task 5: The large still with Vision's boxes

**Files:**
- Create: `web/src/components/TimelineStill.svelte`, `web/src/components/TimelineStill.svelte.test.ts`

**Interfaces:**
- Consumes: `SummaryEntry`, `StillObject` and `Box` from `web/src/lib/vision.ts`.
- Produces: `TimelineStill.svelte` with these props:
  - `src: string`
  - `alt: string`
  - `summary: SummaryEntry[] | null`: null means an unanalysed second, with no boxes and no switch.
  - `loadAll?: () => Promise<StillObject[]>`

  Test ids: `timeline-still` (img), `timeline-boxes` (svg), `timeline-box-label`, `timeline-show-all` (checkbox).

- [ ] **Step 1: Write the failing test**

Create `web/src/components/TimelineStill.svelte.test.ts`:

```ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TimelineStill from './TimelineStill.svelte';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };

function render(props: Record<string, unknown>) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(TimelineStill, { target, props: { src: '/s.jpg', alt: 'still', ...props } });
  flushSync();
  return target;
}
const labels = () => [...target!.querySelectorAll('[data-testid="timeline-box-label"]')].map((l) => l.textContent);

describe('TimelineStill', () => {
  it('draws a box and a label per summary entry, skipping zero-area boxes', () => {
    const t = render({ summary: [{ category: 'person', subtype: 'person', score: 0.84, box }, { category: 'pet', subtype: 'dog', score: 0.5, box: { x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5 } }] });
    expect(t.querySelectorAll('[data-testid="timeline-boxes"] rect')).toHaveLength(1);
    expect(labels()).toEqual(['person 0.84']);
  });

  it('"Show all objects" loads them once and draws them; off again shows the summary', async () => {
    const loadAll = vi.fn(async () => [{ name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.7, box: { x0: 0.5, y0: 0, x1: 0.8, y1: 0.2 } }, { name: 'Clothing', score: 0.6, box: null }]);
    const t = render({ summary: [{ category: 'person', subtype: 'person', score: 0.84, box }], loadAll });
    const all = t.querySelector('[data-testid="timeline-show-all"]') as HTMLInputElement;
    all.click();
    await tick();
    flushSync();
    expect(labels()).toEqual(['Person 0.84', 'Ceiling fan 0.70']);
    all.click();
    flushSync();
    expect(labels()).toEqual(['person 0.84']);
    all.click();
    await tick();
    flushSync();
    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it('is a plain still for a second that was not analysed', () => {
    const t = render({ summary: null });
    expect(t.querySelector('[data-testid="timeline-still"]')?.getAttribute('src')).toBe('/s.jpg');
    expect(t.querySelector('[data-testid="timeline-boxes"]')).toBeNull();
    expect(t.querySelector('[data-testid="timeline-show-all"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web/src/components/TimelineStill.svelte.test.ts`
Expected: FAIL, "Cannot find module './TimelineStill.svelte'".

- [ ] **Step 3: Write `web/src/components/TimelineStill.svelte`**

```svelte
<script lang="ts">
  import type { Box, StillObject, SummaryEntry } from '../lib/vision';

  // The Timeline's large still (spec 2026-09-30-analytics-in-cams-design): for
  // an analysed second, Vision's summary boxes with labels; "Show all objects"
  // draws everything Vision reported instead.
  let { src, alt, summary, loadAll }: { src: string; alt: string; summary: SummaryEntry[] | null; loadAll?: () => Promise<StillObject[]> } = $props();

  let showAll = $state(false);
  let all = $state<StillObject[] | null>(null);
  let failed = $state(false);

  // An object without coordinates arrives as a zero-area box, or none: not drawn.
  const drawn = (b: Box | null | undefined): Box | null => (b && b.x1 > b.x0 && b.y1 > b.y0 ? b : null);
  const boxes = $derived<{ label: string; box: Box }[]>(
    showAll && all
      ? all.flatMap((o) => {
          const b = drawn(o.box);
          return b ? [{ label: `${o.name} ${o.score.toFixed(2)}`, box: b }] : [];
        })
      : (summary ?? []).flatMap((e) => {
          const b = drawn(e.box);
          return b ? [{ label: `${e.subtype} ${e.score.toFixed(2)}`, box: b }] : [];
        }),
  );

  // Another still: back to its summary.
  $effect(() => {
    void src;
    showAll = false;
    all = null;
    failed = false;
  });

  async function toggle() {
    showAll = !showAll;
    if (!showAll || all || !loadAll) return;
    try {
      all = await loadAll();
    } catch {
      failed = true;
      showAll = false;
    }
  }
</script>

<figure>
  <div class="frame">
    <img {src} {alt} data-testid="timeline-still" />
    {#if boxes.length}
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" data-testid="timeline-boxes">
        {#each boxes as b, i (i)}<rect x={b.box.x0} y={b.box.y0} width={b.box.x1 - b.box.x0} height={b.box.y1 - b.box.y0} vector-effect="non-scaling-stroke" />{/each}
      </svg>
      {#each boxes as b, i (i)}<span class="label" data-testid="timeline-box-label" style={`left:${b.box.x0 * 100}%;top:${b.box.y0 * 100}%`}>{b.label}</span>{/each}
    {/if}
  </div>
  {#if summary && loadAll}
    <label class="small"><input type="checkbox" checked={showAll} onchange={() => void toggle()} data-testid="timeline-show-all" /> Show all objects</label>
    {#if failed}<span class="muted small">Could not load all objects.</span>{/if}
  {/if}
</figure>

<style>
  figure { margin: 0; display: grid; gap: 6px; }
  .frame { position: relative; line-height: 0; }
  img { width: 100%; max-height: 60vh; object-fit: contain; background: var(--bg); border-radius: 8px; }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  rect { fill: none; stroke: #a855f7; stroke-width: 3; }
  .label { position: absolute; transform: translateY(-100%); background: #a855f7; color: #fff; font-size: 12px; line-height: 1.4; padding: 0 4px; border-radius: 3px; white-space: nowrap; }
  .small { font-size: 13px; }
  .muted { color: var(--muted); }
</style>
```

Note: with `object-fit: contain`, the image can be letterboxed inside `.frame`, and the boxes would then be offset. The still is 16:9-ish and the frame takes its width, so `.frame` wraps the image exactly. If `max-height` letterboxes it on a very wide screen, drop `max-height` rather than mis-draw the boxes.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run web/src/components/TimelineStill.svelte.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TimelineStill.svelte web/src/components/TimelineStill.svelte.test.ts
git commit -m "feat: the Timeline's large still with Vision's boxes"
```

---

### Task 6: The Timeline on cam-proxy's model

**Files:**
- Modify: `web/src/pages/Timeline.svelte` (rewrite), `web/src/pages/Timeline.svelte.test.ts`, `web/src/components/StripPlayer.svelte` (line ~38)

**Interfaces:**
- Consumes:
  - from Task 4: `stepMinute`, `cardsInMinute`, `cardKind`, `secondKinds`, `minuteMarks`, `analysedSeconds`, `SeenStill`, `TimelineCard`;
  - from Task 5: `TimelineStill`;
  - from Task 2: `GET /api/cameras/:id/analyses/:eventId`;
  - unchanged: `timelineCursor`, `cursorSearch`, `loadViewPoint`, `saveViewPoint`, `nearestMinute`, `stillIndex`, `hourGroups`, `dayRange`, `splitRange`, `tileStyle`.
- Produces: page test ids used by e2e (Task 7):
  - `timeline-hour`
  - `timeline-minute` (with `data-minute`, class `active` / `analysed`)
  - `timeline-minute-count`
  - `timeline-minute-view`
  - `timeline-minute-prev`, `timeline-minute-next`
  - `timeline-close`
  - `timeline-minute-events`
  - `timeline-second` (with `data-ts`, class `analysed`)
  - `timeline-large`
  - `timeline-still`
  - `timeline-open-history`
  - `timeline-message`, `timeline-no-proxy`, `timeline-day`
- Removed: the top viewer (`timeline-viewer`), "Show in timeline grid" (`timeline-show-grid`), the red frame, `toHistory`, `?grid=1`.

Behaviour:
- **A minute click** opens its seconds under its hour card, with a tinted background. It closes any large still. Nothing scrolls, and the page stays.
- **A second click** opens the large still under the minute view:
  - For an analysed second, the analysed still, with its summary.
  - Otherwise the proxy's still at or after that second in that minute, fetched with `/stills?from&to`, because the proxy may keep fewer stills than the sprite has tiles.
- **Keys:**
  - ← → step the minute within the hour (the large still closes).
  - Escape closes the large still first, then the minute view.
- **The URL** `t` is the large still's time, else the open minute's start.
- **The page opens with a time** (the URL's `t`, or the shared view point): it opens that time's minute (or the nearest), opens the still at or after `t`, and scrolls the minute view to the middle of the screen once.
- **The large still is the shared cursor** (view point and History cursor), as the viewer's still was.

- [ ] **Step 1: Rewrite the Timeline unit tests**

In `web/src/pages/Timeline.svelte.test.ts`:

- keep the first four tests: "keeps the open still …", "marks events from the neighbouring camera days …", "says the proxy keeps no stills …" and "retries a sprite …". Their selectors (`timeline-still`, `timeline-minute`, `timeline-minute .img`) still hold;
- in the `shared cursor` describe block, give `open` a second parameter for the sprites and a third for the events, so it reads:

```ts
    async function open(vp?: number | null, sprites: number[] = [m0, minute], events: unknown[] = []) {
      sessionStorage.clear();
      history.replaceState(null, '', '/app/timeline');
      if (vp !== undefined) saveViewPoint('den', vp);
      vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
      vi.stubGlobal('fetch', async (url: string) => {
        if (url.includes('/previews?')) return json(sprites.map(sprite));
        if (url.includes('/stills?')) {
          const from = Number(new URL(url, 'http://x').searchParams.get('from'));
          return json(Array.from({ length: 60 }, (_, i) => from + i * 1000));
        }
        // The cards on their own day only (the page also asks for its neighbours).
        if (url.includes('/events?')) return json({ events: new URL(url, 'http://x').searchParams.get('date') === localDate(new Date(sprites[0])) ? events : [] });
        return json({});
      });
      cameras.set([{ id: 'den', name: 'Den', webUiUrl: null, proxy: true }]);
      selectedCameraId.set('den');
      target = document.createElement('div');
      document.body.appendChild(target);
      component = mount(Timeline, { target });
      for (let i = 0; i < 8; i++) await tick();
      flushSync();
    }
```

  (add `localDate` to the import from `'../lib/recordings'`);
- keep "opens the viewer on the History time it was left at" (rename it to "opens that minute and its still at the History time"), "coming from Live, opens the newest minute" and "opens nothing without a view point for the camera";
- replace "a tile click goes to History at that time" and "a step in the viewer moves the shared cursor" with:

```ts
    const q = (sel: string) => target!.querySelector(sel);
    const qa = (sel: string) => [...target!.querySelectorAll(sel)] as HTMLElement[];

    it('a minute click opens its seconds under its hour, and stays on the page', async () => {
      await open();
      qa('[data-testid="timeline-minute"]')[1].click();
      flushSync();
      expect(location.pathname).toBe('/app/timeline');
      const view = q('[data-testid="timeline-minute-view"]');
      expect(view?.closest('[data-testid="timeline-hour"]')?.contains(qa('[data-testid="timeline-minute"]')[1])).toBe(true);
      expect(qa('[data-testid="timeline-second"]')).toHaveLength(60);
      expect(q('[data-testid="timeline-still"]')).toBeNull();
    });

    it('a second click opens its still and moves the shared cursor', async () => {
      await open();
      qa('[data-testid="timeline-minute"]')[0].click();
      flushSync();
      qa('[data-testid="timeline-second"]')[18].click();
      for (let i = 0; i < 4; i++) await tick();
      flushSync();
      expect(still()).toBe(`/api/cameras/den/stills/${m0 + 18_000}.jpg`);
      expect(loadViewPoint('den')).toEqual({ at: m0 + 18_000 });
      expect(loadCursor()?.cursor.at).toBe(m0 + 18_000);
    });

    it('the arrow keys step the minute within its hour only', async () => {
      const h = new Date();
      h.setHours(10, 58, 0, 0);
      const a = h.getTime();
      await open(a + 5000, [a, a + 60_000, a + 120_000]); // 10:58, 10:59, 11:00
      const active = () => q('[data-testid="timeline-minute"].active')?.getAttribute('data-minute');
      expect(active()).toBe(String(a));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      flushSync();
      expect(active()).toBe(String(a + 60_000));
      expect(q('[data-testid="timeline-still"]')).toBeNull(); // a new minute starts without a still
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      flushSync();
      expect(active()).toBe(String(a + 60_000)); // 11:00 is another hour
    });

    it('an analysed second shows ✦ and opens its still with Vision’s boxes', async () => {
      const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };
      const card = { id: 'c1', start: new Date(m0 + 5000).toISOString(), end: new Date(m0 + 40_000).toISOString(), triggers: ['person'], durationSec: 35, sizeSub: 1, sizeMain: 1,
        analysis: { best: { person: { score: 0.84, subtype: 'person' } }, notConfirmed: [], stills: [{ eventId: 7, stillTs: m0 + 20_000, summary: [{ category: 'person', subtype: 'person', score: 0.84, box }] }] } };
      await open(undefined, [m0, minute], [card]);
      const tile = qa('[data-testid="timeline-minute"]')[0];
      expect(tile.classList.contains('analysed')).toBe(true);
      tile.click();
      flushSync();
      const second = qa('[data-testid="timeline-second"]')[20];
      expect(second.classList.contains('analysed')).toBe(true);
      expect(second.textContent).toContain('✦');
      second.click();
      flushSync();
      expect(still()).toBe(`/api/cameras/den/stills/${m0 + 20_000}.jpg`);
      expect(qa('[data-testid="timeline-boxes"] rect')).toHaveLength(1);
      expect(q('[data-testid="timeline-box-label"]')?.textContent).toBe('person 0.84');
      expect(q('[data-testid="timeline-open-history"]')?.getAttribute('href')).toBe(`/app/recordings?cam=den&panel=history&at=${m0 + 20_000}`);
    });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run web/src/pages/Timeline.svelte.test.ts`
Expected: FAIL. The new tests find no `timeline-minute-view`, `timeline-second` or `data-minute`, and a minute click still navigates to History.

- [ ] **Step 3: Rewrite `web/src/pages/Timeline.svelte`**

Replace the file with:

```svelte
<script lang="ts">
  import { navigate } from '../lib/router';
  import { onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { getJson } from '../lib/api';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { eventStream } from '../lib/eventStream';
  import { liveEventsOn } from '../lib/preferences';
  import { addDays, formatClock, localDate, saveCursor, TRIGGER_LABELS, type Trigger } from '../lib/recordings';
  import { todayDate } from '../lib/refresh';
  import type { StillObject } from '../lib/vision';
  import TimelineStill from '../components/TimelineStill.svelte';
  import {
    analysedSeconds, cardKind, cardsInMinute, cursorSearch, dayRange, hourGroups, loadViewPoint, minuteMarks, nearestMinute, saveViewPoint,
    secondKinds, splitRange, stepMinute, stillIndex, tileStyle, timelineCursor, type PreviewMinute, type SeenStill, type TimelineCard,
  } from '../lib/timeline';

  // A day of the camera's cam-proxy stills (Plan 6) on cam-proxy's model (spec
  // 2026-09-30-analytics-in-cams-design): one tile per minute; a minute opens
  // its seconds under its hour; a second opens the large still, with Vision's
  // boxes where it was analysed. The URL holds the view (?cam&date&t).

  const initial = timelineCursor(new URLSearchParams(location.search), localDate(new Date()));
  // Opened without a position of its own (the menu): the view point shared
  // with History and Live (Klaus, 2026-09-29): History's time, or now.
  const shared = initial.t === null && !new URLSearchParams(location.search).has('date')
    ? loadViewPoint(initial.cam ?? get(selectedCameraId) ?? '')
    : undefined;
  const sharedAt = shared ? (shared.at ?? Date.now()) : null;
  let date = $state(sharedAt !== null ? localDate(new Date(sharedAt)) : initial.date);
  let wantT: number | null = sharedAt ?? initial.t; // a time to open once its day is loaded
  let minutes = $state<PreviewMinute[]>([]);
  let cards = $state<TimelineCard[]>([]);
  let message = $state('');
  let open = $state<PreviewMinute | null>(null); // the minute view
  let still = $state<{ ts: number; seen: SeenStill | null } | null>(null); // the large still
  let refreshTick = $state(0);
  let pickSeq = 0;

  onMount(() => {
    if (initial.cam && $cameras.some((c) => c.id === initial.cam)) selectedCameraId.set(initial.cam);
  });

  const camera = $derived($cameras.find((c) => c.id === $selectedCameraId) ?? null);
  const base = $derived(camera ? `/api/cameras/${encodeURIComponent(camera.id)}` : '');
  const hours = $derived(hourGroups(minutes));
  const firstTile = (m: PreviewMinute) => Math.max(0, m.present.indexOf(true));
  const clock = (ts: number, seconds = false) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
  const labels = (c: TimelineCard) => c.triggers.map((t) => TRIGGER_LABELS[t as Trigger] ?? t).join(', ') || 'Recording';

  // The day's previews (in parts: the fall-back day is 25 h) and cards.
  async function fetchDay(b: string, d: string): Promise<{ m: PreviewMinute[]; ev: TimelineCard[] }> {
    const [from, to] = dayRange(d);
    const [parts, ev] = await Promise.all([
      Promise.all(splitRange(from, to).map(([a, z]) => getJson<PreviewMinute[]>(`${b}/previews?from=${a}&to=${z}`))),
      // The camera's day and its neighbours: with the browser in another
      // zone, the tiles' day spans two camera days (issue #38).
      Promise.all([addDays(d, -1), d, addDays(d, 1)].map((x) => getJson<{ events: TimelineCard[] }>(`${b}/events?date=${x}`).catch(() => ({ events: [] as TimelineCard[] })))),
    ]);
    return { m: parts.flat(), ev: ev.flatMap((x) => x.events) };
  }

  // A camera or day change: clear, then load.
  $effect(() => {
    const cam = camera;
    const d = date;
    minutes = [];
    cards = [];
    open = null;
    still = null;
    message = '';
    if (!cam?.proxy || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    message = 'Loading…';
    let stale = false;
    const b = base;
    fetchDay(b, d).then(
      ({ m, ev }) => {
        if (stale) return;
        minutes = m;
        cards = ev;
        message = m.length ? '' : 'No stills for this day.';
        const t = wantT;
        wantT = null;
        // The minute holding the time, else the nearest one (for now: the newest).
        const target = t === null ? null : nearestMinute(m, t);
        if (target && t !== null) {
          open = target;
          void pick(target, t);
          void reveal();
        }
      },
      (err: Error) => {
        if (stale) return;
        // The proxy answers 404 stills_disabled when it keeps no stills (issue #38).
        message = /HTTP 404/.test(err.message) ? "This camera's cam-proxy keeps no stills." : 'The camera gateway is not reachable right now.';
      },
    );
    return () => (stale = true);
  });

  // A live change on today: refresh in place (the open minute and still stay).
  $effect(() => {
    if (!refreshTick) return;
    const cam = camera;
    const d = date;
    if (!cam?.proxy) return;
    let stale = false;
    fetchDay(base, d).then(
      ({ m, ev }) => {
        if (stale) return;
        minutes = m;
        cards = ev;
        if (m.length) message = '';
        if (open) open = m.find((x) => x.minute === open!.minute) ?? open;
      },
      () => undefined,
    );
    return () => (stale = true);
  });

  $effect(() => {
    void $cameras;
    void $liveEventsOn; // follow the setting (off: no live refresh)
    const stop = eventStream()?.watch(() => camera?.id ?? '', () => { if (date === $todayDate) refreshTick++; }, 5000);
    return () => stop?.();
  });

  // The large still is the shared cursor: History and the Timeline continue
  // from it (Klaus, 2026-09-29).
  $effect(() => {
    const cam = camera?.id;
    const ts = still?.ts ?? null;
    if (!cam || ts === null) return;
    saveViewPoint(cam, ts);
    saveCursor(cam, { date: localDate(new Date(ts)), clipId: null, offsetSec: 0, at: ts });
  });

  // The URL follows the view.
  $effect(() => {
    const search = cursorSearch({ cam: camera?.id ?? null, date, t: still?.ts ?? open?.minute ?? null });
    if (search !== location.search) history.replaceState(history.state, '', `${location.pathname}${search}`);
  });

  // Opened at a time: its minute view in the middle of the screen, once.
  async function reveal() {
    await tick();
    document.querySelector<HTMLElement>('[data-testid="timeline-minute-view"]')?.scrollIntoView?.({ block: 'center' });
  }

  function openMinute(m: PreviewMinute) {
    ++pickSeq; // a still still loading for the minute before is dropped
    open = m;
    still = null;
  }

  // The still for a second: the proxy's still at or after it in that minute
  // (the sprite has a tile per second; the proxy may keep fewer stills).
  async function pick(m: PreviewMinute, target: number) {
    const seq = ++pickSeq;
    try {
      const stills = await getJson<number[]>(`${base}/stills?from=${m.minute}&to=${m.minute + 59_999}`);
      if (seq !== pickSeq || !stills.length) return;
      still = { ts: stills[stillIndex(stills, target, 1)], seen: null };
    } catch {
      if (seq === pickSeq) message = 'Could not load that minute.';
    }
  }

  function openSecond(m: PreviewMinute, i: number, seen: SeenStill | null) {
    if (seen) {
      ++pickSeq;
      still = { ts: seen.stillTs, seen };
      return;
    }
    void pick(m, m.minute + i * m.intervalS * 1000);
  }

  const hourHolding = (m: PreviewMinute) => hours.find((h) => h.minutes.some((x) => x.minute === m.minute))?.minutes ?? [];
  function step(dir: -1 | 1) {
    if (!open) return;
    const list = hourHolding(open);
    const next = stepMinute(list, open.minute, dir);
    const m = next === null ? undefined : list.find((x) => x.minute === next);
    if (m) openMinute(m);
  }
  function close() {
    ++pickSeq;
    open = null;
    still = null;
  }
  function onkey(e: KeyboardEvent) {
    if (!open || (e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'Escape') {
      if (still) still = null;
      else close();
    } else return;
    e.preventDefault();
  }

  const historyHref = (ts: number) => `/app/recordings?cam=${encodeURIComponent(camera!.id)}&panel=history&at=${ts}`;
  const loadAll = (eventId: number) => async (): Promise<StillObject[]> => (await getJson<{ objects: StillObject[] }>(`${base}/analyses/${eventId}`)).objects;

  // Sprites load when their tile scrolls into view (a day is up to 1440).
  // Each is fetched through an Image first, so a refused one (429 after a
  // burst, 2026-09-29) is tried again after 3, 6, 12 and 24 s instead of
  // leaving an empty tile; the tile shows once its sprite has loaded.
  const RETRY_MS = [3000, 6000, 12_000, 24_000];
  function lazyStyle(node: HTMLElement, arg: { style: string; url: string }) {
    let current = arg;
    let visible = false;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (want: { style: string; url: string }, attempt: number) => {
      const img = new Image();
      img.onload = () => {
        if (!gone && current.url === want.url) node.setAttribute('style', current.style);
      };
      img.onerror = () => {
        if (gone || current.url !== want.url || attempt >= RETRY_MS.length) return;
        timer = setTimeout(() => load(want, attempt + 1), RETRY_MS[attempt]);
      };
      img.src = want.url;
    };
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) {
        visible = true;
        io.disconnect();
        load(current, 0);
      }
    }, { rootMargin: '200px' });
    io.observe(node);
    return {
      update(a: { style: string; url: string }) {
        const changed = a.url !== current.url;
        current = a;
        if (!visible) return;
        if (changed) {
          clearTimeout(timer);
          load(current, 0);
        } else if (node.getAttribute('style')) node.setAttribute('style', a.style);
      },
      destroy: () => {
        gone = true;
        clearTimeout(timer);
        io.disconnect();
      },
    };
  }
</script>

<svelte:window onkeydown={onkey} />

<section class="timeline" data-testid="timeline-page">
  <header>
    <h1>Timeline</h1>
    <input type="date" bind:value={date} max={$todayDate} data-testid="timeline-day" aria-label="Day" />
  </header>

  {#if !camera}
    <p class="muted">No camera selected.</p>
  {:else if !camera.proxy}
    <p class="muted" data-testid="timeline-no-proxy">{camera.name} has no camera gateway (cam-proxy), so there are no stills to show.</p>
  {:else}
    {#if message}<p class="muted" data-testid="timeline-message">{message}</p>{/if}
    <p class="muted small">One tile per minute; a coloured edge marks a recording, a purple one what Vision found. Click a minute for its seconds, then a second for its still.</p>
    {#each hours as h (h.minutes[0].minute)}
      <div class="hour" data-testid="timeline-hour">
        <div class="label mono">{String(h.hour).padStart(2, '0')}:00</div>
        <div class="body">
          <div class="tiles">
            {#each h.minutes as m (m.minute)}
              {@const list = cardsInMinute(m, cards)}
              {@const marks = minuteMarks(m, cards)}
              <button class="tile {list.length ? `ev-${cardKind(list[0])}` : ''}" class:active={open?.minute === m.minute} class:analysed={marks.analysed}
                title={clock(m.minute) + (list.length ? ` · ${list.map(labels).join(' · ')}` : '')}
                aria-label={`${clock(m.minute)}${list.length ? `, ${list.map(labels).join('; ')}` : ''}`} aria-expanded={open?.minute === m.minute}
                onclick={() => openMinute(m)} data-testid="timeline-minute" data-minute={m.minute}>
                <span class="img" use:lazyStyle={{ style: tileStyle(m, firstTile(m), 0.5), url: m.url }}></span>
                {#if marks.count > 1}<span class="count" data-testid="timeline-minute-count">×{marks.count}</span>{/if}
              </button>
            {/each}
          </div>
          {#if open && h.minutes.some((x) => x.minute === open!.minute)}
            {@const m = open}
            {@const evs = cardsInMinute(m, cards)}
            {@const kinds = secondKinds(m, cards)}
            {@const seen = analysedSeconds(m, cards)}
            <div class="detail" data-testid="timeline-minute-view">
              <div class="bar">
                <strong class="mono">{clock(m.minute)}</strong>
                <span class="spacer"></span>
                <button data-testid="timeline-minute-prev" title="Previous minute" aria-label="Previous minute" disabled={stepMinute(h.minutes, m.minute, -1) === null} onclick={() => step(-1)}>◀</button>
                <button data-testid="timeline-minute-next" title="Next minute" aria-label="Next minute" disabled={stepMinute(h.minutes, m.minute, 1) === null} onclick={() => step(1)}>▶</button>
                <button data-testid="timeline-close" onclick={close}>Close</button>
              </div>
              {#if evs.length}
                <p class="small" data-testid="timeline-minute-events">
                  {#each evs as e (e.id)}<span class="evtag ev-{cardKind(e)}">{labels(e)} {formatClock(e.start)}–{formatClock(e.end)}</span>{/each}
                </p>
              {/if}
              <div class="seconds">
                {#each m.present as ok, i (i)}
                  {@const ts = m.minute + i * m.intervalS * 1000}
                  <button class="second {kinds[i] ? `ev-${kinds[i]}` : ''}" class:missing={!ok} class:analysed={seen[i] !== null}
                    class:active={still !== null && still.ts >= ts && still.ts < ts + m.intervalS * 1000}
                    disabled={!ok} style={tileStyle(m, i, 0.6)} title={clock(ts, true)} aria-label={`${clock(ts, true)}${seen[i] ? ', analysed by Vision' : ''}`}
                    onclick={() => openSecond(m, i, seen[i])} data-testid="timeline-second" data-ts={ts}>{#if seen[i]}<span class="spark">✦</span>{/if}</button>
                {/each}
              </div>
              {#if still}
                {@const s = still}
                <div class="large" data-testid="timeline-large">
                  <TimelineStill src={`${base}/stills/${s.ts}.jpg`} alt={`${camera.name} at ${clock(s.ts, true)}`} summary={s.seen?.summary ?? null} loadAll={s.seen ? loadAll(s.seen.eventId) : undefined} />
                  <div class="bar">
                    <span class="mono">{clock(s.ts, true)}</span>
                    <!-- History at this second, paused, without boxes (Klaus, 2026-09-30). -->
                    <a data-testid="timeline-open-history" href={historyHref(s.ts)}
                      onclick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate((e.currentTarget as HTMLAnchorElement).getAttribute('href')!); } }}>Open in History</a>
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/each}
  {/if}
</section>

<style>
  .timeline { display: grid; gap: 12px; }
  header { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 20px; }
  input { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 10px; }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
  .mono { font-family: var(--mono); }
  .hour { display: grid; grid-template-columns: 52px 1fr; gap: 8px; align-items: start; }
  .label { color: var(--muted); font-size: 12px; padding-top: 4px; }
  .body { display: grid; gap: 8px; min-width: 0; }
  .tiles, .seconds { display: flex; flex-wrap: wrap; gap: 3px; }
  .tile, .second { position: relative; padding: 0; border: 2px solid transparent; border-radius: 4px; background-color: var(--surface-2); background-repeat: no-repeat; cursor: pointer; line-height: 0; }
  .tile:hover, .second:hover:not(:disabled) { border-color: var(--accent); }
  .tile.active { outline: 3px solid var(--accent); outline-offset: 1px; }
  .tile.analysed { box-shadow: 0 0 0 2px #a855f7; }
  .second.analysed { outline: 2px solid #a855f7; outline-offset: 1px; }
  .second.active { outline: 3px solid var(--accent); outline-offset: 1px; }
  .second.missing { opacity: 0.25; cursor: default; }
  .img { display: block; width: 80px; height: 45px; }
  .count { position: absolute; right: 2px; bottom: 2px; background: rgb(0 0 0 / 0.7); color: #fff; font-size: 10px; line-height: 1.3; padding: 0 3px; border-radius: 3px; }
  .spark { position: absolute; top: 1px; left: 3px; color: #a855f7; font-size: 11px; line-height: 1; }
  /* The open minute stands apart from the hour's tiles (cam-proxy, Klaus 2026-09-30). */
  .detail { display: grid; gap: 8px; padding: 10px 12px; border-radius: var(--radius); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .bar button { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 4px 10px; cursor: pointer; }
  .spacer { flex: 1; }
  .evtag { display: inline-block; margin-right: 10px; padding-left: 6px; border-left: 4px solid; }
  .large { display: grid; gap: 6px; }
  .ev-motion { border-color: #f59e0b; } .ev-person { border-color: #ef4444; } .ev-vehicle { border-color: #3b82f6; } .ev-pet { border-color: #22c55e; } .ev-timer { border-color: var(--muted); }
  @media (max-width: 600px) {
    .hour { grid-template-columns: 1fr; }
  }
</style>
```

- [ ] **Step 4: History's link without `grid=1`**

In `web/src/components/StripPlayer.svelte`:

- remove `&grid=1` from `timelineHref`. It becomes `` `/app/timeline?cam=${encodeURIComponent(cam)}&date=${localDate(new Date(at))}&t=${Math.floor(at / 1000) * 1000}` ``;
- change the comment above the link to `<!-- This moment in the Timeline: its minute opens with the still (Klaus, 2026-09-30). -->`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run web/src/pages/Timeline.svelte.test.ts web/src/components/StripPlayer.svelte.test.ts web/src/lib/timeline.test.ts`
Expected: PASS.

Run: `npm test && npm run check && npm run check:svelte`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Timeline.svelte web/src/pages/Timeline.svelte.test.ts web/src/components/StripPlayer.svelte
git commit -m "feat: the Timeline on cam-proxy's model, with Vision's analysed stills"
```

---

### Task 7: e2e, README and CHANGELOG

**Files:**
- Modify:
  - `e2e/fakeProxyData.ts`: `seed()` returns the media.
  - `test/proxy/fakeProxy.ts`: a `POST /analyses` test hook.
  - `e2e/timeline.spec.ts`
  - `README.md`
  - `CHANGELOG.md`
- Create: `e2e/vision.spec.ts`

**Interfaces:**
- Consumes: every test id from Tasks 3, 5 and 6; `FakeAnalysis` from Task 1; the existing `/push` hook.
- Produces: the hook `POST http://127.0.0.1:8093/analyses` with `{cam, analysis: FakeAnalysis}`. It stores the analysis and gives its still's minute one still per second and a sprite.

**Why every e2e test pushes the message:**
- The cams server caches a day's analyses for 60 s, and the e2e servers are shared across tests and projects. A test that only stored an analysis in the fake would race that cache.
- So each test also sends the stream message, which cams keeps live.
- The spec's "a day load after a restart shows the badge" is the fetch path. Task 1's `AnalysisStore` tests cover it (fetched, cached, overlaid) against the fake proxy.

- [ ] **Step 1: The test hook**

In `e2e/fakeProxyData.ts`, change `seed` to return its media:

- the signature becomes `export function seed(fake: FakeProxy): { jpeg: Buffer; sprite: Buffer } {`;
- add `return { jpeg, sprite };` at its end.

In `test/proxy/fakeProxy.ts`, at the bottom (`require.main === module`):

- change `seed(fake);` to `const media = seed(fake);`;
- after the `/push` hook, add:

```ts
    // e2e only: POST /analyses {cam, analysis} stores an analysis (for
    // /analyses and the full record) and gives its still's minute one still
    // per second and a sprite, so the Timeline can show it.
    hooks.post('/analyses', (req, res) => {
      const b = req.body as { cam?: unknown; analysis?: FakeAnalysis };
      const a = b.analysis;
      if (typeof b.cam !== 'string' || !a || !Number.isSafeInteger(a.eventId) || !Number.isSafeInteger(a.start)) return void res.status(400).json({ error: 'cam and analysis' });
      fake.analyses.set(b.cam, [...(fake.analyses.get(b.cam) ?? []).filter((x) => x.eventId !== a.eventId), a]);
      if (a.stillTs !== null) {
        const minute = Math.floor(a.stillTs / 60_000) * 60_000;
        const stills = fake.stills.get(b.cam) ?? new Map<number, Buffer>();
        for (let s = 0; s < 60; s++) stills.set(minute + s * 1000, media.jpeg);
        fake.stills.set(b.cam, stills);
        const previews = fake.previews.get(b.cam) ?? new Map<number, Buffer>();
        previews.set(minute, media.sprite);
        fake.previews.set(b.cam, previews);
      }
      res.json({ ok: true });
    });
```

- [ ] **Step 2: Write `e2e/vision.spec.ts`**

```ts
import { expect, test, type Page } from '@playwright/test';
import { FAKE_PROXY_PORT } from './fakeProxyData';
import { signIn } from './session';

// Vision in cams (spec 2026-09-30-analytics-in-cams-design, in cam-proxy).
// Den (cam1) has cam-sim's demo recordings (today 08:15:10 person, …) and the
// fake cam-proxy. A test hook stores an analysis for today's person card, and
// the stream message announces it, as cam-proxy does. The fake and cams keep
// state across tests and projects, so each analysis carries a unique subtype
// and the tests look for that.
const HOOKS = `http://127.0.0.1:${FAKE_PROXY_PORT - 2}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const box = { x0: 0.2, y0: 0.3, x1: 0.4, y1: 0.9 };
interface Card { id: string; start: string; end: string; triggers: string[] }

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

async function personCard(page: Page): Promise<Card> {
  const r = await page.request.get(`/api/cameras/cam1/events?date=${today()}`);
  expect(r.ok()).toBe(true);
  const card = ((await r.json()) as { events: Card[] }).events.find((e) => e.triggers.includes('person'));
  expect(card, "cam-sim's demo person clip of today").toBeTruthy();
  return card!;
}

// Stores an analysis of the card's person event and sends its stream message.
async function analyse(page: Page, card: Card): Promise<{ eventId: number; stillTs: number; subtype: string }> {
  const eventId = 100_000 + Math.floor(Math.random() * 900_000);
  const subtype = `e2e-${eventId}`;
  const start = Date.parse(card.start) + 1000;
  const stillTs = start + 1000;
  const msg = { eventId, kind: 'person', start, end: start + 4000, provider: 'google-vision', status: 'ok', reason: null, stillTs, summary: [{ category: 'person', subtype, score: 0.84, box }] };
  const objects = [{ name: 'Person', score: 0.84, box }, { name: 'Ceiling fan', score: 0.7, box: { x0: 0.5, y0: 0.05, x1: 0.8, y1: 0.2 } }];
  expect((await page.request.post(`${HOOKS}/analyses`, { data: { cam: 'cam1', analysis: { ...msg, objects } } })).ok()).toBe(true);
  expect((await page.request.post(`${HOOKS}/push`, { data: { cam: 'cam1', type: 'analysis', data: msg } })).ok()).toBe(true);
  return { eventId, stillTs, subtype };
}

const badge = (page: Page, card: Card) => page.locator(`[data-testid="event-card"][data-clip-id="${card.id}"]`).locator('[data-testid="vision-badge"][data-kind="agree"]');

test('a card shows Vision’s confidence next to the camera’s label', async ({ page }) => {
  const card = await personCard(page);
  const { subtype } = await analyse(page, card);
  await page.goto(`/app/recordings?cam=cam1&panel=history&date=${today()}`);
  await expect(badge(page, card)).toHaveText(/^✦ Vision \d+%$/);
  await expect(badge(page, card)).toHaveAttribute('title', new RegExp(subtype));
});

test('a new analysis updates the open page without a reload', async ({ page }) => {
  const card = await personCard(page);
  await page.goto(`/app/recordings?cam=cam1&panel=history&date=${today()}`);
  await expect(page.locator(`[data-testid="event-card"][data-clip-id="${card.id}"]`)).toBeVisible();
  const { subtype } = await analyse(page, card);
  await expect(badge(page, card)).toHaveAttribute('title', new RegExp(subtype), { timeout: 15_000 });
});

test('Live’s recent events show the badge too', async ({ page }) => {
  const card = await personCard(page);
  await analyse(page, card);
  await page.goto('/app/live');
  await page.getByTestId('camera-picker').selectOption('cam1');
  await expect(page.getByTestId('live-recent').locator('[data-testid="vision-badge"][data-kind="agree"]').first()).toBeVisible();
});

test('the Timeline marks the analysed second and shows its boxes; "Open in History" lands paused', async ({ page }) => {
  const card = await personCard(page);
  const { stillTs } = await analyse(page, card);
  const minute = Math.floor(stillTs / 60_000) * 60_000;
  await page.goto(`/app/timeline?cam=cam1&date=${today()}`);
  const tile = page.locator(`[data-testid="timeline-minute"][data-minute="${minute}"]`);
  await expect(tile).toHaveClass(/analysed/);
  await tile.click();
  const second = page.locator(`[data-testid="timeline-second"][data-ts="${stillTs}"]`);
  await expect(second).toHaveClass(/analysed/);
  await second.click();
  await expect(page.getByTestId('timeline-still')).toHaveAttribute('src', `/api/cameras/cam1/stills/${stillTs}.jpg`);
  await expect(page.locator('[data-testid="timeline-boxes"] rect')).toHaveCount(1);
  await page.getByTestId('timeline-show-all').check();
  await expect(page.locator('[data-testid="timeline-boxes"] rect')).toHaveCount(2);
  await page.getByTestId('timeline-open-history').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('at')).toBe(String(stillTs));
  await expect(page.getByTestId('source-badge')).toBeVisible();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-pressed', 'false');
});
```

- [ ] **Step 3: Rewrite `e2e/timeline.spec.ts` for the new Timeline**

- Keep unchanged:
  - `beforeEach`;
  - "from Live, the Timeline menu opens the newest minute" (it finds `timeline-still`);
  - "the Timeline explains a camera without a gateway";
  - "the Recordings timeline previews the frame under the pointer";
  - "History offers no Timeline link for a camera without a gateway".
- Delete:
  - `expectRedFrame`;
  - "\"Show in timeline grid\" scrolls to the selected minute, framed in red";
  - "the viewer's still opens that moment in History".
- Replace the first test with:

```ts
test('a minute opens its seconds under its hour; a second opens the still; "Open in History" lands paused there', async ({ page }) => {
  await page.goto('/app/timeline');
  await page.getByTestId('camera-picker').selectOption('cam1');
  const tiles = page.getByTestId('timeline-minute');
  await expect(tiles.first()).toBeVisible();
  expect(await tiles.count()).toBeGreaterThanOrEqual(10);
  const tile = tiles.last();
  await tile.click();
  await expect(page).toHaveURL(/\/app\/timeline\?/); // Klaus, 2026-09-30: it stays on the Timeline
  const hour = page.getByTestId('timeline-hour').filter({ has: tile });
  await expect(hour.getByTestId('timeline-minute-view')).toBeVisible();
  await page.getByTestId('timeline-minute-view').getByTestId('timeline-second').nth(10).click();
  const still = page.getByTestId('timeline-still');
  await expect(still).toBeVisible();
  const ts = /stills\/(\d+)\.jpg/.exec((await still.getAttribute('src'))!)![1];
  await page.getByTestId('timeline-open-history').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('at')).toBe(ts);
  await expect(page.getByTestId('source-badge')).toBeVisible();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-pressed', 'false');
});
```

- Replace "from History, the Timeline menu opens the viewer at that time; steps and a reload keep it" with:

```ts
test('from History, the Timeline menu opens that minute and still; a minute step and a reload keep the minute', async ({ page }, testInfo) => {
  const at = Math.floor((Date.now() - 180_000) / 1000) * 1000; // three minutes ago: inside the fake's stills
  await page.goto(`/app/recordings?cam=cam1&panel=history&at=${at}`);
  await expect(page.getByTestId('source-badge')).toBeVisible();
  if (testInfo.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-timeline').click();
  } else await page.getByTestId('sidebar').getByTestId('nav-timeline').click();
  const still = page.getByTestId('timeline-still');
  await expect(still).toBeVisible();
  const shown = Number(/stills\/(\d+)\.jpg/.exec((await still.getAttribute('src'))!)![1]);
  expect(Math.abs(shown - at)).toBeLessThanOrEqual(60_000); // the nearest still to History's time
  await expect.poll(() => still.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(896);
  await expect(page.getByTestId('timeline-minute-view')).toBeInViewport();
  const active = page.locator('[data-testid="timeline-minute"].active');
  const before = Number(await active.getAttribute('data-minute'));
  // Step to a neighbour inside the hour: back unless this is the hour's first minute.
  const back = !(await page.getByTestId('timeline-minute-prev').isDisabled());
  const after = before + (back ? -60_000 : 60_000);
  await page.keyboard.press(back ? 'ArrowLeft' : 'ArrowRight');
  await expect(active).toHaveAttribute('data-minute', String(after));
  await expect(page.getByTestId('timeline-still')).toHaveCount(0); // a new minute starts without a still
  await expect(page).toHaveURL(new RegExp(`cam=cam1&date=\\d{4}-\\d{2}-\\d{2}&t=${after}$`));
  await page.reload();
  await expect(page.locator('[data-testid="timeline-minute"].active')).toHaveAttribute('data-minute', String(after));
  await page.getByTestId('timeline-close').click();
  await expect(page.getByTestId('timeline-minute-view')).toHaveCount(0);
});
```

- Replace "History's \"Show in Timeline\" opens the Timeline at that moment, the minute framed in red and in view" with:

```ts
test('History\'s "Show in Timeline" opens that minute under its hour, with the still in view', async ({ page }) => {
  const at = Math.floor((Date.now() - 180_000) / 1000) * 1000;
  await page.goto(`/app/recordings?cam=cam1&panel=history&at=${at}`);
  await expect(page.getByTestId('source-badge')).toBeVisible();
  const link = page.getByTestId('show-in-timeline');
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/app\/timeline\?cam=cam1&date=\d{4}-\d{2}-\d{2}&t=\d+$/);
  const src = await page.getByTestId('timeline-still').getAttribute('src');
  expect(Math.abs(Number(/stills\/(\d+)\.jpg/.exec(src!)![1]) - at)).toBeLessThanOrEqual(60_000);
  await expect(page.getByTestId('timeline-minute-view')).toBeInViewport();
});
```

- [ ] **Step 4: Run e2e**

Run: `npm run build && npx playwright test e2e/vision.spec.ts e2e/timeline.spec.ts`
Expected: PASS on both projects (desktop and phone).

Run: `npx playwright test`
Expected: PASS, the whole e2e suite.

- [ ] **Step 5: README and CHANGELOG**

`README.md`:

- replace the Timeline feature bullet (the line starting `- **Timeline:**`) with:

  `- **Timeline:** the Timeline page (in the menu when some camera has a proxy) shows a day's stills as one tile per minute, marks recording minutes, and on cam-proxy's model opens a minute's 60 seconds under its hour (◀ ▶ and the arrow keys step within the hour). A second opens the large still; "Open in History" opens History there, paused. History's "Show in Timeline" (in the line under the video) opens the Timeline at the player's moment.`

- after it, add:

  `- **Vision:** where the camera's cam-proxy analyses events with Google Vision, a card shows Vision's confidence next to the camera's label ("✦ Vision 84%"), "✦ Vision: not confirmed" when Vision found none, or an extra finding ("+ Pet 70%"); the tooltip names what Vision saw. The Timeline marks analysed minutes and seconds in purple and draws Vision's boxes on the analysed still ("Show all objects" draws everything it reported). The camera's labels never change; the proxy's raw answer stays with the proxy.`

- in the **Pages** line, replace `a tile opens History at that minute, and from the menu it opens at History's position, or the newest minute after Live` with `a minute opens its seconds under its hour and a second its still; from the menu it opens at History's position, or the newest minute after Live`.

`CHANGELOG.md`, under `## [Unreleased]`:

```markdown
- **Vision on the cards:** with cam-proxy's Google Vision analytics (cam-proxy v2026.10 or later), event cards in History and Live show Vision's confidence next to the camera's label ("✦ Vision 84%"), "not confirmed" when Vision found none, or an extra finding ("+ Pet 70%"). New analyses arrive live.
- **Timeline on cam-proxy's model:** a minute opens its seconds under its hour, a second opens the large still with Vision's boxes ("Show all objects"), and "Open in History" opens History paused at that second. The top viewer, "Show in timeline grid" and the red frame are gone.
```

- [ ] **Step 6: Commit**

```bash
git add e2e/fakeProxyData.ts test/proxy/fakeProxy.ts e2e/vision.spec.ts e2e/timeline.spec.ts README.md CHANGELOG.md
git commit -m "test: Vision and the new Timeline end to end; docs"
```

---

## After the plan (not tasks for the implementer)

- **Order:** Plan A (cam-proxy) ships first: release it, then update the Pi (`docker compose pull && up -d`) and check the cluster's cam2 proxy. cams works with either proxy version, so its PR can merge before or after.
- **Live check on cam1:** walk in front of the camera and confirm:
  - the card badge appears without a reload;
  - the Timeline's ✦ second shows the box.
- **Update the Obsidian notes:**
  - *Cameras*: cams shows Vision.
  - *cam-proxy on the Pi*: the version.
