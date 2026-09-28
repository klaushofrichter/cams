# History Continuous Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** History plays a camera's past as one continuous strip. The playhead stays centred, and playback runs in real time through clips, proxy stills, preview tiles and empty stretches, across midnight, with a badge that names the source.

**Architecture:**
- A pure model (`lib/strip.ts`) answers "what is at time t" from coverage runs.
- A per-camera data layer (`lib/dayCache.ts`, `lib/stripData.ts`) loads events per local day, previews per day and stills per hour, and dedupes the requests.
- Three components replace History's player and timeline:
  - `Strip.svelte`: the centred bar and its interaction.
  - `StripPlayer.svelte`: one clock, two alternating `<video>` elements, stills and the badge.
  - `HistoryView.svelte`: glues the two together and reports the position.
- `Recordings.svelte` keeps the page chrome (header, side panels, banners) and moves the URL to an `at` position.

**Tech Stack:** Svelte 5 (runes), TypeScript, vitest (+ jsdom component tests), Playwright, Express 5 (one server validation change).

**Spec:** `docs/superpowers/specs/2026-09-27-history-strip-design.md`

## Global Constraints

- The playhead stays centred at **every** zoom. The zooms are exactly `24, 12, 6, 3, 1` hours.
- Priority at a moment: clip (SD) > still > preview > nothing. After now it is the future.
- Nothing recorded: play through in **real time** with a "No recording" panel.
- The strip is continuous across local midnight. The URL date follows the playhead's local day.
- Badge texts, verbatim:
  - `SD 10 FPS`
  - `Stills 1 FPS`
  - `Preview 1 FPS`
  - `No recording`
  - `Live is on the Live page`
- Strip colours are theme tokens: `--strip-empty`, `--strip-future` and `--strip-preview`. Stills use the bar's `--surface-2`. All three tokens are defined in all three theme blocks of `web/src/styles/theme.css`.
- Every colour comes from `theme.css` tokens (CLAUDE.md). Every new UI element used by e2e gets a `data-testid`. e2e runs at 1440×900 and 390×844.
- The existing History test ids stay on the new components, so current e2e selectors keep meaning:
  - `clip-video`, `play-toggle`, `back-10`, `fwd-10`, `prev-clip`, `next-clip`, `clip-time`
  - `timeline` (the bar), `timeline-seg` with `data-clip-id`, `zoom-<h>`, `scrub-preview`
- Live's mini timeline (`Timeline.svelte`, `compact legend`) and the Timeline page stay unchanged except where a task says so.
- **Ruling 1:** the URL position is `at=<epoch ms>`, not `t`. `t` already means "offset in seconds in the clip" in every existing link. Old links (`date`, `clip`, `t`) still open at the same moment.
- **Ruling 2:** there is one server change, the preference validation for zooms 12 and 3. The spec said "no server changes" but also that `timelineZoom` gains 12 and 3. That is impossible without it.
- Tests run with `TZ=America/Chicago` (vitest config). Clip ids are `YYYYMMDD-HHMMSS-HHMMSS` in local time.

## Review Focus

- **DST days (23 and 25 h):** local-day iteration, tick labels and clip-id parsing stay right. Pinned in Task 1 (`windowAround`/`localDaysBetween` on 2026-11-01) and Task 4 (tick at 01:00 twice).
- **A proxy that goes away mid-play:** stills fail to load or the stills list fails. Playback keeps going, showing the last good frame or "No recording", with no error loop. Pinned in Task 2 (a failed hour is cached as empty and retried later) and Task 5 (a failed still keeps the previous frame).
- **A clip that won't load** (camera refusing, proxy without it): it is marked failed once. Playback continues through the span as stills or nothing, it doesn't retry every tick, and its segment is shown failed. Pinned in Task 5 and Task 4 (the `failed` class).
- **A hidden tab or sleep, then back:** real time only advances while playing, and never past now. A blocked `play()` (autoplay policy) sets `playing = false`. Pinned in Task 5.
- **Fast drags and wheel scrolls across several days:** no request storm, because loads are deduped per day or hour. URL updates are throttled (2 s, replace). Pinned in Task 2 (dedupe) and Task 6 (throttle).

---

## File Structure

| File | Responsibility |
|---|---|
| `web/src/lib/strip.ts` (new) | Pure model: runs, `sourceAt`, `nextChange`, `stripSpans`, `windowAround`, id and day helpers |
| `web/src/lib/dayCache.ts` (new) | One `events` request per (camera, day), deduped and refreshable, as a store |
| `web/src/lib/stripData.ts` (new) | Per camera: loads days (events, previews) and stills hours around a window; builds `Coverage` |
| `web/src/lib/zoomPref.ts` (new) | The zoom preference: the reactive value and a serialized save (moved out of `Timeline.svelte`) |
| `web/src/components/Strip.svelte` (new) | The centred bar: spans, segments, playhead, now, ticks, zoom, drag, wheel, click, keys, hover |
| `web/src/components/StripPlayer.svelte` (new) | The clock, video A/B, stills, preview tile, panel, badge, controls |
| `web/src/components/HistoryView.svelte` (new) | Owns `at` and `playing`; wires data, strip and player; reports the position |
| `web/src/pages/Recordings.svelte` | Uses `HistoryView`; `at` in the URL; list highlight; day picker; `dayCache` for the list |
| `web/src/lib/recordings.ts` | `Cursor.at`, parse and write `at`; `Zoom` type |
| `server/preferences.ts` | Accepts zooms 24, 12, 6, 3, 1 |
| `web/src/components/Timeline.svelte` | Loses the History-only zoom, pan and hover code (Live's legend mode stays) |
| `web/src/components/ClipPlayer.svelte` | Deleted (replaced by `StripPlayer`) |
| `e2e/fakeProxyData.ts`, `e2e/recordings.spec.ts`, `e2e/timeline.spec.ts` | Fixtures and History e2e |
| `web/src/styles/theme.css` | Strip tokens |

---

### Task 1: The strip model

**Files:**
- Create: `web/src/lib/strip.ts`
- Test: `web/src/lib/strip.test.ts`

**Interfaces:**
- Consumes: `EventClip` from `web/src/lib/recordings.ts` (`{ id, start: string ISO, end: string ISO, durationSec, triggers, sizeSub, sizeMain }`); `PreviewMinute` from `web/src/lib/timeline.ts` (`{ minute, cols, rows, tileW, tileH, intervalS, present: boolean[], url }`); `localDate`, `addDays` from `web/src/lib/recordings.ts`.
- Produces:
  ```ts
  export type StripZoom = 24 | 12 | 6 | 3 | 1;
  export const STRIP_ZOOMS: StripZoom[];                       // [24, 12, 6, 3, 1]
  export interface Run { start: number; end: number }          // UTC ms, [start, end)
  export interface ClipRun extends Run { clip: EventClip }
  export interface Coverage { clips: ClipRun[]; stills: Run[]; previews: Run[] }
  export type Source =
    | { kind: 'clip'; clip: EventClip; offsetMs: number }
    | { kind: 'still'; ts: number }
    | { kind: 'preview'; ts: number }
    | { kind: 'none' }
    | { kind: 'future' };
  export type SpanKind = 'stills' | 'preview' | 'none' | 'future';
  export const EMPTY_COVERAGE: Coverage;
  export function mergeRuns(runs: Run[], gapMs?: number): Run[];
  export function inRuns<T extends Run>(runs: T[], t: number): T | null;
  export function clipRuns(events: EventClip[], failed?: ReadonlySet<string>): ClipRun[];
  export function stillRuns(ts: number[]): Run[];              // 1 s each, gaps < 3 s bridged
  export function previewRuns(minutes: PreviewMinute[]): Run[];
  export function sourceAt(cov: Coverage, t: number, now: number): Source;
  export function nextChange(cov: Coverage, t: number, now: number): number | null;
  export function windowAround(t: number, zoom: StripZoom): Run;
  export function stripSpans(cov: Coverage, win: Run, now: number): { kind: SpanKind; left: number; width: number }[];
  export function clipStartFromId(id: string): number | null;
  export function localDaysBetween(from: number, to: number): string[];
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/lib/strip.test.ts
import { describe, expect, it } from 'vitest';
import {
  clipRuns, clipStartFromId, inRuns, localDaysBetween, mergeRuns, nextChange, previewRuns, sourceAt, stillRuns, stripSpans, windowAround,
  type Coverage,
} from './strip';
import type { EventClip } from './recordings';
import type { PreviewMinute } from './timeline';

// TZ=America/Chicago (vitest config). 2026-09-27 is CDT (-05:00).
const at = (hhmmss: string, day = '2026-09-27') => Date.parse(`${day}T${hhmmss}-05:00`);
const clip = (id: string, s: string, e: string): EventClip => ({
  id, start: new Date(at(s)).toISOString(), end: new Date(at(e)).toISOString(), durationSec: (at(e) - at(s)) / 1000, triggers: ['motion'], sizeSub: 1, sizeMain: 1,
});
const NOW = at('20:00:00');

describe('runs', () => {
  it('merges touching and nearby runs', () => {
    expect(mergeRuns([{ start: 5, end: 8 }, { start: 0, end: 5 }, { start: 20, end: 30 }])).toEqual([{ start: 0, end: 8 }, { start: 20, end: 30 }]);
    expect(mergeRuns([{ start: 0, end: 5 }, { start: 7, end: 9 }], 3)).toEqual([{ start: 0, end: 9 }]);
  });
  it('finds the run containing t, end exclusive', () => {
    const r = [{ start: 0, end: 10 }];
    expect(inRuns(r, 0)).toEqual(r[0]);
    expect(inRuns(r, 10)).toBeNull();
  });
  it('turns still timestamps into runs, bridging gaps under 3 s', () => {
    expect(stillRuns([0, 1000, 2000, 4000, 9000])).toEqual([{ start: 0, end: 5000 }, { start: 9000, end: 10_000 }]);
  });
  it('turns preview minutes into runs of present tiles', () => {
    const m = (minute: number, present: boolean[]): PreviewMinute => ({ minute, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present, url: '' });
    const p = Array(60).fill(true).map((_, i) => i < 30);
    expect(previewRuns([m(60_000, p), m(120_000, Array(60).fill(true))])).toEqual([{ start: 60_000, end: 90_000 }, { start: 120_000, end: 180_000 }]);
  });
  it('builds clip runs, leaving out failed clips', () => {
    const c = clip('20260927-120000-120030', '12:00:00', '12:00:30');
    expect(clipRuns([c])).toEqual([{ start: at('12:00:00'), end: at('12:00:30'), clip: c }]);
    expect(clipRuns([c], new Set([c.id]))).toEqual([]);
  });
});

describe('sourceAt / nextChange', () => {
  const c = clip('20260927-120000-120030', '12:00:00', '12:00:30');
  const cov: Coverage = {
    clips: clipRuns([c]),
    stills: [{ start: at('11:59:00'), end: at('12:05:00') }],
    previews: [{ start: at('11:00:00'), end: at('12:10:00') }],
  };
  it('prefers the clip, then stills, then previews, then nothing; future after now', () => {
    expect(sourceAt(cov, at('12:00:10'), NOW)).toEqual({ kind: 'clip', clip: c, offsetMs: 10_000 });
    expect(sourceAt(cov, at('12:01:00.500'), NOW)).toEqual({ kind: 'still', ts: at('12:01:00') });
    expect(sourceAt(cov, at('12:07:00'), NOW)).toEqual({ kind: 'preview', ts: at('12:07:00') });
    expect(sourceAt(cov, at('13:00:00'), NOW)).toEqual({ kind: 'none' });
    expect(sourceAt(cov, NOW, NOW)).toEqual({ kind: 'future' });
  });
  it('names the next moment the source may change', () => {
    expect(nextChange(cov, at('11:59:30'), NOW)).toBe(at('12:00:00'));
    expect(nextChange(cov, at('12:00:10'), NOW)).toBe(at('12:00:30'));
    expect(nextChange(cov, at('12:11:00'), NOW)).toBe(NOW);
    expect(nextChange(cov, NOW, NOW)).toBeNull();
  });
});

describe('window and spans', () => {
  it('centres the window on t', () => {
    expect(windowAround(10 * 3_600_000, 1)).toEqual({ start: 9.5 * 3_600_000, end: 10.5 * 3_600_000 });
    expect(windowAround(10 * 3_600_000, 24)).toEqual({ start: -2 * 3_600_000, end: 22 * 3_600_000 });
  });
  it('colours the window: stills, preview, nothing, future', () => {
    const cov: Coverage = { clips: [], stills: [{ start: 0, end: 25 }], previews: [{ start: 0, end: 50 }] };
    expect(stripSpans(cov, { start: 0, end: 100 }, 75)).toEqual([
      { kind: 'stills', left: 0, width: 25 },
      { kind: 'preview', left: 25, width: 25 },
      { kind: 'none', left: 50, width: 25 },
      { kind: 'future', left: 75, width: 25 },
    ]);
  });
});

describe('ids and days', () => {
  it('reads a clip id as local time', () => {
    expect(clipStartFromId('20260927-120505-120530')).toBe(at('12:05:05'));
    expect(clipStartFromId('nonsense')).toBeNull();
  });
  it('lists the local days a span touches, DST-safe', () => {
    expect(localDaysBetween(at('23:00:00', '2026-09-26'), at('01:00:00', '2026-09-28'))).toEqual(['2026-09-26', '2026-09-27', '2026-09-28']);
    // 2026-11-01 is 25 hours long in Chicago
    const fallStart = new Date(2026, 10, 1).getTime();
    expect(localDaysBetween(fallStart, fallStart + 24.5 * 3_600_000)).toEqual(['2026-11-01']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/lib/strip.test.ts`
Expected: FAIL, "Failed to resolve import './strip'".

- [ ] **Step 3: Implement**

```ts
// web/src/lib/strip.ts
import { addDays, localDate, type EventClip } from './recordings';
import type { PreviewMinute } from './timeline';

// The History strip (spec 2026-09-27-history-strip-design.md): what is at a
// moment, from the runs of clips, stills and preview tiles a camera has.
// Times are UTC ms; runs are [start, end).

export type StripZoom = 24 | 12 | 6 | 3 | 1;
export const STRIP_ZOOMS: StripZoom[] = [24, 12, 6, 3, 1];

export interface Run { start: number; end: number }
export interface ClipRun extends Run { clip: EventClip }
export interface Coverage { clips: ClipRun[]; stills: Run[]; previews: Run[] }
export type Source =
  | { kind: 'clip'; clip: EventClip; offsetMs: number }
  | { kind: 'still'; ts: number }
  | { kind: 'preview'; ts: number }
  | { kind: 'none' }
  | { kind: 'future' };
export type SpanKind = 'stills' | 'preview' | 'none' | 'future';

export const EMPTY_COVERAGE: Coverage = { clips: [], stills: [], previews: [] };

export function mergeRuns(runs: Run[], gapMs = 0): Run[] {
  const sorted = runs.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Run[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gapMs) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

export function inRuns<T extends Run>(runs: T[], t: number): T | null {
  for (const r of runs) if (t >= r.start && t < r.end) return r;
  return null;
}

export function clipRuns(events: EventClip[], failed: ReadonlySet<string> = new Set()): ClipRun[] {
  return events
    .filter((e) => !failed.has(e.id))
    .map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end), clip: e }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
}

// One still per second; a few missing seconds still read as one run (the
// player shows the last good frame).
export function stillRuns(ts: number[]): Run[] {
  return mergeRuns(ts.map((t) => ({ start: t, end: t + 1000 })), 2000);
}

export function previewRuns(minutes: PreviewMinute[]): Run[] {
  const runs: Run[] = [];
  for (const m of minutes) {
    const step = m.intervalS * 1000;
    m.present.forEach((on, i) => {
      if (on) runs.push({ start: m.minute + i * step, end: m.minute + (i + 1) * step });
    });
  }
  return mergeRuns(runs);
}

export function sourceAt(cov: Coverage, t: number, now: number): Source {
  if (t >= now) return { kind: 'future' };
  const c = inRuns(cov.clips, t);
  if (c) return { kind: 'clip', clip: c.clip, offsetMs: t - c.start };
  const second = Math.floor(t / 1000) * 1000;
  if (inRuns(cov.stills, t)) return { kind: 'still', ts: second };
  if (inRuns(cov.previews, t)) return { kind: 'preview', ts: second };
  return { kind: 'none' };
}

// The next boundary after t where sourceAt may give something else.
export function nextChange(cov: Coverage, t: number, now: number): number | null {
  if (t >= now) return null;
  let best = now;
  for (const list of [cov.clips, cov.stills, cov.previews] as Run[][]) {
    for (const r of list) {
      if (r.start > t && r.start < best) best = r.start;
      if (r.end > t && r.end < best) best = r.end;
    }
  }
  return best;
}

export function windowAround(t: number, zoom: StripZoom): Run {
  const half = (zoom * 3_600_000) / 2;
  return { start: t - half, end: t + half };
}

export function stripSpans(cov: Coverage, win: Run, now: number): { kind: SpanKind; left: number; width: number }[] {
  const cuts = new Set<number>([win.start, win.end]);
  if (now > win.start && now < win.end) cuts.add(now);
  for (const list of [cov.stills, cov.previews]) {
    for (const r of list) {
      if (r.start > win.start && r.start < win.end) cuts.add(r.start);
      if (r.end > win.start && r.end < win.end) cuts.add(r.end);
    }
  }
  const pts = [...cuts].sort((a, b) => a - b);
  const len = win.end - win.start;
  const out: { kind: SpanKind; left: number; width: number }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const mid = (a + b) / 2;
    const kind: SpanKind = mid >= now ? 'future' : inRuns(cov.stills, mid) ? 'stills' : inRuns(cov.previews, mid) ? 'preview' : 'none';
    const last = out[out.length - 1];
    const left = ((a - win.start) / len) * 100;
    const width = ((b - a) / len) * 100;
    if (last && last.kind === kind) last.width += width;
    else out.push({ kind, left, width });
  }
  return out;
}

const ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-\d{6}$/;
export function clipStartFromId(id: string): number | null {
  const m = ID.exec(id);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

// The local calendar days [from, to] touches (by calendar, not by 24 h steps).
export function localDaysBetween(from: number, to: number): string[] {
  const out: string[] = [];
  const last = localDate(new Date(to));
  for (let d = localDate(new Date(from)); d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web/src/lib/strip.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/strip.ts web/src/lib/strip.test.ts
git commit -m "feat(history): strip model (sources, runs, spans, window)"
```

---

### Task 2: Day cache and strip data

**Files:**
- Create: `web/src/lib/dayCache.ts`, `web/src/lib/stripData.ts`
- Test: `web/src/lib/dayCache.test.ts`, `web/src/lib/stripData.test.ts`

**Interfaces:**
- Consumes: Task 1 (`clipRuns`, `stillRuns`, `previewRuns`, `localDaysBetween`, `Coverage`, `EMPTY_COVERAGE`); `eventsUrl`, `EventClip` from `recordings.ts`; `dayRange`, `splitRange`, `PreviewMinute` from `timeline.ts`; `getJson` from `api.ts`.
- Produces:
  ```ts
  // dayCache.ts
  export interface DayEvents { events: EventClip[]; downloads: 'ok' | 'proxy' | 'unavailable' }
  export type Fetch = <T>(url: string) => Promise<T>;
  export function loadDay(cam: string, day: string, opts?: { force?: boolean; fetch?: Fetch }): Promise<DayEvents>;
  export const dayStore: import('svelte/store').Readable<Map<string, DayEvents>>; // key `${cam}|${day}`
  export function resetDayCache(): void;                        // tests
  // stripData.ts
  export interface StripData {
    coverage: import('svelte/store').Readable<Coverage>;
    previews: import('svelte/store').Readable<PreviewMinute[]>;   // for hover and preview playback
    ensure(from: number, to: number): void;                      // days of [from, to] plus one either side
    ensureStills(t: number): void;                               // the hour of t and the next
    markFailed(clipId: string): void;
    eventsOn(day: string): EventClip[] | null;                   // null: not loaded yet
    destroy(): void;
  }
  export function createStripData(cam: string, proxy: boolean, fetch?: Fetch): StripData;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/lib/dayCache.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { dayStore, loadDay, resetDayCache } from './dayCache';

beforeEach(() => resetDayCache());

describe('dayCache', () => {
  it('asks once per camera and day, also for requests in flight', async () => {
    const fetch = vi.fn(async () => ({ events: [], downloads: 'ok' }));
    await Promise.all([loadDay('den', '2026-09-27', { fetch }), loadDay('den', '2026-09-27', { fetch })]);
    await loadDay('den', '2026-09-27', { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(get(dayStore).get('den|2026-09-27')).toEqual({ events: [], downloads: 'ok' });
  });

  it('asks again when forced (a refresh of today)', async () => {
    const fetch = vi.fn(async () => ({ events: [], downloads: 'ok' }));
    await loadDay('den', '2026-09-27', { fetch });
    await loadDay('den', '2026-09-27', { fetch, force: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('forgets a failed request, so the next call tries again', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('502')).mockResolvedValue({ events: [], downloads: 'ok' });
    await expect(loadDay('den', '2026-09-27', { fetch })).rejects.toThrow('502');
    await loadDay('den', '2026-09-27', { fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
```

```ts
// web/src/lib/stripData.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createStripData } from './stripData';
import { resetDayCache } from './dayCache';

// TZ=America/Chicago. 2026-09-27 12:00 CDT.
const NOON = Date.parse('2026-09-27T12:00:00-05:00');
const ev = { id: '20260927-120000-120030', start: '2026-09-27T17:00:00.000Z', end: '2026-09-27T17:00:30.000Z', durationSec: 30, triggers: ['motion'], sizeSub: 1, sizeMain: 1 };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetDayCache());

function fakeFetch(fail: RegExp | null = null) {
  const urls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    urls.push(url);
    if (fail && fail.test(url)) throw new Error('502');
    if (url.includes('/events?date=2026-09-27')) return { events: [ev], downloads: 'ok' };
    if (url.includes('/events?')) return { events: [], downloads: 'ok' };
    if (url.includes('/previews?')) return [];
    if (url.includes('/stills?')) return [NOON, NOON + 1000, NOON + 2000];
    throw new Error(`unexpected ${url}`);
  });
  return { fn, urls };
}

describe('createStripData', () => {
  it('loads the days a window touches plus one either side, once', async () => {
    const { fn, urls } = fakeFetch();
    const d = createStripData('den', true, fn);
    d.ensure(NOON - 3_600_000, NOON + 3_600_000);
    d.ensure(NOON - 60_000, NOON + 60_000); // same days: no new requests
    await flush();
    expect(urls.filter((u) => u.includes('/events?')).map((u) => u.split('date=')[1]).sort()).toEqual(['2026-09-26', '2026-09-27', '2026-09-28']);
    expect(get(d.coverage).clips.map((c) => c.clip.id)).toEqual([ev.id]);
    expect(d.eventsOn('2026-09-27')).toEqual([ev]);
    expect(d.eventsOn('2026-09-20')).toBeNull();
  });

  it('loads stills by the hour and turns them into runs', async () => {
    const { fn, urls } = fakeFetch();
    const d = createStripData('den', true, fn);
    d.ensureStills(NOON + 10_000);
    d.ensureStills(NOON + 20_000);
    await flush();
    expect(urls.filter((u) => u.includes('/stills?'))).toHaveLength(2); // this hour and the next
    expect(get(d.coverage).stills).toEqual([{ start: NOON, end: NOON + 3000 }]);
  });

  it('asks nothing of a proxy the camera does not have', async () => {
    const { fn, urls } = fakeFetch();
    const d = createStripData('shed', false, fn);
    d.ensure(NOON, NOON);
    d.ensureStills(NOON);
    await flush();
    expect(urls.some((u) => u.includes('/stills?') || u.includes('/previews?'))).toBe(false);
  });

  it('treats a failed stills hour as empty and tries it again after a minute', async () => {
    vi.useFakeTimers();
    try {
      const { fn, urls } = fakeFetch(/\/stills\?/);
      const d = createStripData('den', true, fn);
      d.ensureStills(NOON);
      await vi.advanceTimersByTimeAsync(0);
      d.ensureStills(NOON);
      await vi.advanceTimersByTimeAsync(0);
      expect(urls.filter((u) => u.includes('/stills?'))).toHaveLength(2); // not retried at once
      vi.advanceTimersByTime(61_000);
      d.ensureStills(NOON);
      await vi.advanceTimersByTimeAsync(0);
      expect(urls.filter((u) => u.includes('/stills?'))).toHaveLength(4);
      expect(get(d.coverage).stills).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a failed clip from the coverage', async () => {
    const { fn } = fakeFetch();
    const d = createStripData('den', true, fn);
    d.ensure(NOON, NOON);
    await flush();
    d.markFailed(ev.id);
    expect(get(d.coverage).clips).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/lib/dayCache.test.ts web/src/lib/stripData.test.ts`
Expected: FAIL, "Failed to resolve import './dayCache'" / "'./stripData'".

- [ ] **Step 3: Implement**

```ts
// web/src/lib/dayCache.ts
import { get, writable, type Readable } from 'svelte/store';
import { getJson } from './api';
import { eventsUrl, type EventClip } from './recordings';

// One `events` request per (camera, day), shared by the Recordings list and
// the History strip, so both never ask for the same day twice.
export interface DayEvents { events: EventClip[]; downloads: 'ok' | 'proxy' | 'unavailable' }
export type Fetch = <T>(url: string) => Promise<T>;

const store = writable<Map<string, DayEvents>>(new Map());
export const dayStore: Readable<Map<string, DayEvents>> = { subscribe: store.subscribe };
const inflight = new Map<string, Promise<DayEvents>>();

export function loadDay(cam: string, day: string, opts: { force?: boolean; fetch?: Fetch } = {}): Promise<DayEvents> {
  const key = `${cam}|${day}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const have = get(store).get(key);
  if (have && !opts.force) return Promise.resolve(have);
  const fetch = opts.fetch ?? getJson;
  const p = fetch<{ events: EventClip[]; downloads?: DayEvents['downloads'] }>(eventsUrl(cam, day))
    .then((r) => {
      const v: DayEvents = { events: r.events, downloads: r.downloads ?? 'ok' };
      store.update((m) => new Map(m).set(key, v));
      return v;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function resetDayCache(): void {
  inflight.clear();
  store.set(new Map());
}
```

```ts
// web/src/lib/stripData.ts
import { derived, writable, get, type Readable } from 'svelte/store';
import { getJson } from './api';
import { dayStore, loadDay, type Fetch } from './dayCache';
import { addDays, localDate, type EventClip } from './recordings';
import { dayRange, splitRange, type PreviewMinute } from './timeline';
import { clipRuns, EMPTY_COVERAGE, localDaysBetween, mergeRuns, previewRuns, stillRuns, type Coverage, type Run } from './strip';

// A camera's strip data (spec: Strip / Data): events and previews per local
// day for the days a window touches plus one either side, stills per hour
// around the playhead. Every request is made once; a failed stills or
// previews request counts as empty and is tried again after a minute.
export interface StripData {
  coverage: Readable<Coverage>;
  previews: Readable<PreviewMinute[]>;
  ensure(from: number, to: number): void;
  ensureStills(t: number): void;
  markFailed(clipId: string): void;
  eventsOn(day: string): EventClip[] | null;
  destroy(): void;
}

const HOUR = 3_600_000;
const RETRY_MS = 60_000;

export function createStripData(cam: string, proxy: boolean, fetch: Fetch = getJson): StripData {
  const days = new Set<string>();                       // days asked for
  const previewDays = new Map<string, PreviewMinute[]>();
  const stillHours = new Map<number, Run[]>();
  const failedAt = new Map<string, number>();           // `p|day` / `s|hour` → when it failed
  const failed = writable(new Set<string>());
  const bump = writable(0);                             // previews / stills changed
  const enc = encodeURIComponent(cam);
  let alive = true;

  const retryable = (key: string) => {
    const t = failedAt.get(key);
    return t === undefined || Date.now() - t > RETRY_MS;
  };

  function loadPreviews(day: string) {
    const key = `p|${day}`;
    if (!proxy || previewDays.has(day) || !retryable(key)) return;
    previewDays.set(day, []);
    const [from, to] = dayRange(day);
    Promise.all(splitRange(from, to).map(([a, z]) => fetch<PreviewMinute[]>(`/api/cameras/${enc}/previews?from=${a}&to=${z}`)))
      .then((parts) => {
        if (!alive) return;
        previewDays.set(day, parts.flat());
        failedAt.delete(key);
        bump.update((n) => n + 1);
      })
      .catch(() => {
        previewDays.delete(day);
        failedAt.set(key, Date.now());
      });
  }

  function ensure(from: number, to: number) {
    const list = localDaysBetween(from, to);
    const all = [addDays(list[0], -1), ...list, addDays(list[list.length - 1], 1)];
    for (const day of all) {
      if (!days.has(day)) {
        days.add(day);
        loadDay(cam, day, { fetch }).catch(() => days.delete(day));
      }
      loadPreviews(day);
    }
  }

  function ensureStills(t: number) {
    if (!proxy) return;
    const h0 = Math.floor(t / HOUR) * HOUR;
    for (const h of [h0, h0 + HOUR]) {
      const key = `s|${h}`;
      if (stillHours.has(h) || !retryable(key)) continue;
      stillHours.set(h, []);
      fetch<number[]>(`/api/cameras/${enc}/stills?from=${h}&to=${h + HOUR - 1}`)
        .then((ts) => {
          if (!alive) return;
          stillHours.set(h, stillRuns(ts));
          failedAt.delete(key);
          bump.update((n) => n + 1);
        })
        .catch(() => {
          stillHours.delete(h);
          failedAt.set(key, Date.now());
        });
    }
  }

  const events = derived(dayStore, (m) => {
    const out: EventClip[] = [];
    for (const day of days) out.push(...(m.get(`${cam}|${day}`)?.events ?? []));
    return out;
  });
  const previews = derived(bump, () => [...previewDays.values()].flat().sort((a, b) => a.minute - b.minute));
  const coverage = derived([events, failed, bump], ([evs, f]) => ({
    clips: clipRuns(evs, f),
    stills: mergeRuns([...stillHours.values()].flat(), 2000),
    previews: previewRuns([...previewDays.values()].flat()),
  }));

  return {
    coverage: { subscribe: (fn) => (alive ? coverage.subscribe(fn) : (fn(EMPTY_COVERAGE), () => undefined)) },
    previews,
    ensure,
    ensureStills,
    markFailed: (id) => failed.update((s) => new Set(s).add(id)),
    eventsOn: (day) => get(dayStore).get(`${cam}|${day}`)?.events ?? null,
    destroy: () => {
      alive = false;
    },
  };
}

export { localDate };
```

Note: `events` derives from `days`, which is a plain `Set`. A day added by `ensure` becomes visible once `dayStore` updates, which happens when that day's response arrives. That is the only moment it could change anything.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web/src/lib/dayCache.test.ts web/src/lib/stripData.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/dayCache.ts web/src/lib/dayCache.test.ts web/src/lib/stripData.ts web/src/lib/stripData.test.ts
git commit -m "feat(history): day cache and per-camera strip data"
```

---

### Task 3: Five zooms, saved

**Files:**
- Create: `web/src/lib/zoomPref.ts`, `web/src/lib/zoomPref.test.ts`
- Modify: `server/preferences.ts:12,125` (the type and the validation)
- Modify: `web/src/lib/preferences.ts:8` (`timelineZoom` type)
- Modify: `web/src/lib/recordings.ts:3` (`export type Zoom = 24 | 12 | 6 | 3 | 1;`)
- Modify: `web/src/pages/Settings.svelte:255-257` (the options)
- Test: `test/preferences.test.ts` (the valid and invalid zooms)

**Interfaces:**
- Consumes: `preferences`, `savePreferences` from `web/src/lib/preferences.ts`; `StripZoom` from Task 1.
- Produces:
  ```ts
  export const zoom: import('svelte/store').Readable<StripZoom>; // the saved zoom, 24 until loaded
  export function pickZoom(z: StripZoom): Promise<void>;        // optimistic; saves serialized (last pick wins)
  ```

- [ ] **Step 1: Write the failing tests**

In `test/preferences.test.ts`, the invalid-values table currently lists `[{ timelineZoom: 12 }]` (line 36). Replace it with `[{ timelineZoom: 5 }]` and add:

```ts
  it('accepts the strip zooms 24, 12, 6, 3 and 1', async () => {
    for (const z of [24, 12, 6, 3, 1]) {
      const res = await request(createApp()).put('/api/preferences').set('Cookie', klaus).send({ timelineZoom: z });
      expect(res.status).toBe(200);
      expect(res.body.timelineZoom).toBe(z);
    }
  });
```

```ts
// web/src/lib/zoomPref.test.ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { pickZoom, zoom } from './zoomPref';
import { preferences, type Preferences } from './preferences';

const PREFS: Preferences = { defaultCamera: null, liveQuality: 'sub', eventFilter: 'all', timelineZoom: 24, liveKeepAlive: 60 };
afterEach(() => {
  vi.unstubAllGlobals();
  preferences.set(null);
});

describe('zoomPref', () => {
  it('follows the saved preference, 24 until it loads', () => {
    expect(get(zoom)).toBe(24);
    preferences.set({ ...PREFS, timelineZoom: 3 });
    expect(get(zoom)).toBe(3);
  });

  it('saves picks one after another; the last pick wins', async () => {
    const sent: number[] = [];
    const answers: (() => void)[] = [];
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => {
      const z = JSON.parse(String(init.body)).timelineZoom;
      sent.push(z);
      return new Promise<Response>((r) => answers.push(() => r(new Response(JSON.stringify({ ...PREFS, timelineZoom: z }), { status: 200 }))));
    });
    preferences.set(PREFS);
    const a = pickZoom(12);
    const b = pickZoom(3);
    expect(get(zoom)).toBe(3); // optimistic
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([12]);
    answers[0]();
    await a;
    expect(get(zoom)).toBe(3); // the older answer doesn't win
    await new Promise((r) => setTimeout(r, 0));
    answers[1]();
    await b;
    expect(sent).toEqual([12, 3]);
    expect(get(zoom)).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/preferences.test.ts web/src/lib/zoomPref.test.ts`
Expected: FAIL. The server answers 400 for 12 and 3, and `./zoomPref` does not resolve.

- [ ] **Step 3: Implement**

In `server/preferences.ts`:
- line 12: `timelineZoom: 24 | 12 | 6 | 3 | 1;`
- line 125: `if ('timelineZoom' in b && ![24, 12, 6, 3, 1].includes(b.timelineZoom as number)) details.push('timelineZoom: 24, 12, 6, 3 or 1');`

In `web/src/lib/preferences.ts` line 8: `timelineZoom: 24 | 12 | 6 | 3 | 1;`.

In `web/src/lib/recordings.ts` line 3: `export type Zoom = 24 | 12 | 6 | 3 | 1;`.

In `web/src/pages/Settings.svelte`, replace the three options with:

```svelte
            <option value={24}>24 hours</option><option value={12}>12 hours</option><option value={6}>6 hours</option><option value={3}>3 hours</option><option value={1}>1 hour</option>
```

```ts
// web/src/lib/zoomPref.ts
import { derived, get, type Readable } from 'svelte/store';
import { preferences, savePreferences } from './preferences';
import type { StripZoom } from './strip';

// The History strip's zoom is the saved preference (Klaus, 2026-09-27): a
// pick applies at once and is saved; saves go one after another and the
// store ends with the last pick, whatever order the answers arrive in.
export const zoom: Readable<StripZoom> = derived(preferences, (p) => (p?.timelineZoom ?? 24) as StripZoom);

let chain: Promise<unknown> = Promise.resolve();
let latest: StripZoom | null = null;

export function pickZoom(z: StripZoom): Promise<void> {
  latest = z;
  preferences.update((p) => (p ? { ...p, timelineZoom: z } : p));
  const run = chain.then(async () => {
    await savePreferences({ timelineZoom: z }).catch(() => false);
    if (latest !== null && get(preferences)?.timelineZoom !== latest) preferences.update((p) => (p ? { ...p, timelineZoom: latest! } : p));
  });
  chain = run.catch(() => undefined);
  return run;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/preferences.test.ts web/src/lib/zoomPref.test.ts && npm run check`
Expected: PASS, and `check` exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/preferences.ts test/preferences.test.ts web/src/lib/preferences.ts web/src/lib/recordings.ts web/src/pages/Settings.svelte web/src/lib/zoomPref.ts web/src/lib/zoomPref.test.ts
git commit -m "feat(history): zooms 24/12/6/3/1 h, saved and serialized"
```

---

### Task 4: The strip bar

**Files:**
- Create: `web/src/components/Strip.svelte`, `web/src/components/Strip.svelte.test.ts`
- Modify: `web/src/styles/theme.css` (tokens)

**Interfaces:**
- Consumes: Task 1 (`windowAround`, `stripSpans`, `Coverage`, `STRIP_ZOOMS`, `StripZoom`); Task 3 (`zoom`, `pickZoom`); `previewAt`, `tileStyle`, `PreviewMinute` from `timeline.ts`; `EventClip`, `localDate` from `recordings.ts`.
- Produces: the `<Strip>` props:
  ```ts
  {
    coverage: Coverage;
    events: EventClip[];                  // all loaded events (segments)
    visibleIds: ReadonlySet<string>;      // the filter: others are dimmed
    failedIds: ReadonlySet<string>;       // shown as failed
    at: number; now: number;
    currentId: string | null;             // the clip under the playhead (outlined)
    previews: PreviewMinute[];            // hover frames
    thumbFor?: (clipId: string) => string;
    onseek: (at: number) => void;          // click, drag, wheel, keys
    ondrag?: (active: boolean) => void;    // true on drag start, false on drag end
    onstep?: (dir: -1 | 1) => void;        // ArrowLeft/Right: previous/next event
  }
  ```
  Test ids: `timeline` (the bar), `timeline-seg` (`data-clip-id`, classes `dim` and `failed`), `strip-span` (`data-kind`), `strip-playhead`, `timeline-now`, `zoom-24|12|6|3|1`, `strip-tick`, `scrub-preview`.

- [ ] **Step 1: Add the theme tokens**

In `web/src/styles/theme.css`, after `--no-thumb-line` in each of the three blocks (`:root`, `:root[data-theme='light']`, and the `prefers-color-scheme: light` block):
- dark (`:root`):
  ```css
  --strip-empty: #1B2233;
  --strip-future: #05080F;
  --strip-preview: #131D33;
  ```
- both light blocks:
  ```css
  --strip-empty: #C9D2DF;
  --strip-future: #9AA6B8;
  --strip-preview: #E4EBF5;
  ```

- [ ] **Step 2: Write the failing tests**

```ts
// web/src/components/Strip.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Strip from './Strip.svelte';
import { preferences, type Preferences } from '../lib/preferences';
import type { Coverage } from '../lib/strip';
import type { EventClip } from '../lib/recordings';

const PREFS: Preferences = { defaultCamera: null, liveQuality: 'sub', eventFilter: 'all', timelineZoom: 1, liveKeepAlive: 60 };
const T = Date.parse('2026-09-27T12:00:00-05:00');
const ev = (id: string, s: number, sec = 60): EventClip => ({ id, start: new Date(s).toISOString(), end: new Date(s + sec * 1000).toISOString(), durationSec: sec, triggers: ['motion'], sizeSub: 1, sizeMain: 1 });
const cov: Coverage = { clips: [], stills: [{ start: T - 600_000, end: T }], previews: [] };

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  preferences.set(null);
});
function render(props: Record<string, unknown>) {
  preferences.set(PREFS);
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(Strip, { target, props: { coverage: cov, events: [], visibleIds: new Set(), failedIds: new Set(), at: T, now: T + 1_800_000, currentId: null, previews: [], onseek: () => undefined, ...props } });
  flushSync();
  const bar = target.querySelector('[data-testid="timeline"]') as HTMLElement;
  bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 46, right: 600, bottom: 46, x: 0, y: 0, toJSON: () => ({}) });
  return bar;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('Strip', () => {
  it('centres the playhead and colours the window', () => {
    render({});
    expect(q('strip-playhead')!.style.left).toBe('50%');
    const kinds = [...target!.querySelectorAll('[data-testid="strip-span"]')].map((e) => (e as HTMLElement).dataset.kind);
    expect(kinds).toEqual(['stills', 'none', 'future']);
  });

  it('offers five zooms', () => {
    render({});
    for (const z of [24, 12, 6, 3, 1]) expect(q(`zoom-${z}`)).not.toBeNull();
    expect(q('zoom-1')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('seeks to the time under a click (1 h window: 600 px = 60 min)', () => {
    const onseek = vi.fn();
    const bar = render({ onseek });
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: 400, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointerup', { clientX: 400, bubbles: true }));
    expect(onseek).toHaveBeenCalledWith(T + 10 * 60_000);
  });

  it('drags time under the playhead: right moves back in time', () => {
    const onseek = vi.fn();
    const ondrag = vi.fn();
    const bar = render({ onseek, ondrag });
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointermove', { clientX: 330, bubbles: true }));
    bar.dispatchEvent(new PointerEvent('pointerup', { clientX: 330, bubbles: true }));
    expect(ondrag).toHaveBeenNthCalledWith(1, true);
    expect(onseek).toHaveBeenLastCalledWith(T - 3 * 60_000);
    expect(ondrag).toHaveBeenLastCalledWith(false);
  });

  it('scrolls time with a sideways wheel', () => {
    const onseek = vi.fn();
    const bar = render({ onseek });
    bar.dispatchEvent(new WheelEvent('wheel', { deltaX: 60, bubbles: true, cancelable: true }));
    expect(onseek).toHaveBeenCalledWith(T + 6 * 60_000);
  });

  it('dims filtered-out events and marks failed ones', () => {
    const a = ev('20260927-115000-115100', T - 600_000);
    const b = ev('20260927-120500-120600', T + 300_000);
    render({ events: [a, b], visibleIds: new Set([a.id]), failedIds: new Set([b.id]) });
    const segs = [...target!.querySelectorAll('[data-testid="timeline-seg"]')] as HTMLElement[];
    expect(segs.map((s) => [s.dataset.clipId, s.classList.contains('dim'), s.classList.contains('failed')])).toEqual([
      [a.id, false, false],
      [b.id, true, true],
    ]);
  });

  it('labels hours, twice on the 25-hour day, and dates at midnight', () => {
    render({ at: new Date(2026, 10, 1, 1, 30).getTime(), now: new Date(2026, 10, 2).getTime(), coverage: { clips: [], stills: [], previews: [] } });
    preferences.set({ ...PREFS, timelineZoom: 6 });
    flushSync();
    const labels = [...target!.querySelectorAll('[data-testid="strip-tick"]')].map((e) => e.textContent);
    expect(labels.filter((l) => l === '01:00')).toHaveLength(2);
    expect(labels).toContain('Sun 1');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run web/src/components/Strip.svelte.test.ts`
Expected: FAIL, "Failed to resolve import './Strip.svelte'".

- [ ] **Step 4: Implement**

```svelte
<!-- web/src/components/Strip.svelte -->
<script lang="ts">
  import { stripSpans, windowAround, STRIP_ZOOMS, type Coverage } from '../lib/strip';
  import { zoom, pickZoom } from '../lib/zoomPref';
  import { previewAt, tileStyle, type PreviewMinute } from '../lib/timeline';
  import type { EventClip } from '../lib/recordings';

  // History's strip (spec 2026-09-27): the playhead stays in the centre and
  // time moves under it. Drag, sideways wheel, click and ←/→ move it.
  let {
    coverage, events, visibleIds, failedIds, at, now, currentId, previews, thumbFor, onseek, ondrag, onstep,
  }: {
    coverage: Coverage;
    events: EventClip[];
    visibleIds: ReadonlySet<string>;
    failedIds: ReadonlySet<string>;
    at: number;
    now: number;
    currentId: string | null;
    previews: PreviewMinute[];
    thumbFor?: (clipId: string) => string;
    onseek: (at: number) => void;
    ondrag?: (active: boolean) => void;
    onstep?: (dir: -1 | 1) => void;
  } = $props();

  const win = $derived(windowAround(at, $zoom));
  const span = $derived(win.end - win.start);
  const pct = (t: number) => ((t - win.start) / span) * 100;
  const spans = $derived(stripSpans(coverage, win, now));
  const segs = $derived(
    events
      .map((e) => ({ e, s: Date.parse(e.start), t: Date.parse(e.end) }))
      .filter(({ s, t }) => t > win.start && s < win.end)
      .map(({ e, s, t }) => ({ id: e.id, left: pct(Math.max(s, win.start)), width: Math.max(0.3, pct(Math.min(t, win.end)) - pct(Math.max(s, win.start))), ai: e.triggers.some((x) => x !== 'motion') })),
  );
  const nowLeft = $derived(now > win.start && now < win.end ? pct(now) : null);

  // Hour ticks from the clock (labels say what the wall clock says, so the
  // repeated hour on the 25-hour day shows twice); a date at midnight.
  const ticks = $derived.by(() => {
    const h = $zoom >= 12 ? 3 : $zoom === 6 ? 1 : $zoom === 3 ? 0.5 : 0.25;
    const step = h * 3_600_000;
    const out: { left: number; label: string }[] = [];
    for (let t = Math.ceil(win.start / step) * step; t <= win.end; t += step) {
      const d = new Date(t);
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      const label = midnight
        ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
        : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      out.push({ left: pct(t), label });
    }
    return out;
  });

  // Pointer: a press that moves less than 4 px is a click (seek there);
  // otherwise a drag (time follows the pointer, right = back in time).
  let press: { x: number; at: number; moved: boolean } | null = null;
  function timeAtX(e: PointerEvent | MouseEvent, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    return at + ((e.clientX - r.left - r.width / 2) / r.width) * span;
  }
  function down(e: PointerEvent) {
    press = { x: e.clientX, at, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function move(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (press) {
      const dx = e.clientX - press.x;
      if (!press.moved && Math.abs(dx) >= 4) {
        press.moved = true;
        hover = null;
        ondrag?.(true);
      }
      if (press.moved) onseek(press.at - (dx / el.getBoundingClientRect().width) * span);
      return;
    }
    hoverAt(timeAtX(e, el), e, el);
  }
  function up(e: PointerEvent) {
    if (!press) return;
    const moved = press.moved;
    press = null;
    if (moved) ondrag?.(false);
    else onseek(timeAtX(e, e.currentTarget as HTMLElement));
  }
  function wheel(e: WheelEvent) {
    const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
    if (!dx) return;
    e.preventDefault();
    onseek(at + (dx / (e.currentTarget as HTMLElement).getBoundingClientRect().width) * span);
  }
  function keydown(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      onstep?.(e.key === 'ArrowLeft' ? -1 : 1);
    }
  }

  // Hover: the preview frame of that second, or the event's thumbnail (after
  // a 150 ms rest, as before).
  const REST_MS = 150;
  let hover = $state<{ left: number; label: string; style: string | null; img?: string } | null>(null);
  let rest: ReturnType<typeof setTimeout> | undefined;
  function hoverAt(t: number, e: PointerEvent, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const left = ((e.clientX - r.left) / r.width) * 100;
    const label = new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = previewAt(previews, t);
    const ev = !p && thumbFor ? events.find((x) => t >= Date.parse(x.start) && t < Date.parse(x.end)) : undefined;
    if (!p && !ev) return leave();
    const style = p ? tileStyle(p.minute, p.index, 1) : null;
    const img = ev && thumbFor ? thumbFor(ev.id) : undefined;
    const same = hover && (hover.style === style || (img && hover.img === img));
    hover = { left, label, style: same ? hover!.style : null, img: same ? hover!.img : undefined };
    if (same) return;
    clearTimeout(rest);
    rest = setTimeout(() => {
      if (hover) hover = { ...hover, style, img };
    }, REST_MS);
  }
  function leave() {
    clearTimeout(rest);
    hover = null;
  }
</script>

<div class="wrap">
  {#if hover}
    <div class="scrub" style={`left: clamp(84px, ${hover.left}%, calc(100% - 84px))`} data-testid="scrub-preview" aria-hidden="true">
      {#if hover.img}<img class="frame" src={hover.img} alt="" width="160" height="90" onerror={() => hover && (hover = { ...hover, img: undefined })} />
      {:else}<span class="frame" style={hover.style ?? 'width: 160px; height: 90px'}></span>{/if}
      <span class="when">{hover.label}</span>
    </div>
  {/if}
  <div class="tools">
    <div class="zoom" role="group" aria-label="Timeline zoom">
      {#each STRIP_ZOOMS as z (z)}
        <button data-testid={`zoom-${z}`} aria-pressed={$zoom === z} onclick={() => void pickZoom(z)}>{z} h</button>
      {/each}
    </div>
  </div>
  <div class="bar" data-testid="timeline" role="slider" tabindex="0" aria-label="Recordings timeline" aria-valuenow={Math.round(at / 1000)}
    onpointerdown={down} onpointermove={move} onpointerup={up} onpointerleave={leave} onwheel={wheel} onkeydown={keydown}>
    {#each spans as s, i (i)}
      <span class={`span ${s.kind}`} data-testid="strip-span" data-kind={s.kind} style={`left:${s.left}%;width:${s.width}%`}></span>
    {/each}
    {#each segs as s (s.id)}
      <span class="seg" class:ai={s.ai} class:on={s.id === currentId} class:dim={!visibleIds.has(s.id)} class:failed={failedIds.has(s.id)}
        data-testid="timeline-seg" data-clip-id={s.id} style={`left:${s.left}%;width:${s.width}%`}></span>
    {/each}
    {#if nowLeft !== null}<span class="now" data-testid="timeline-now" style={`left:${nowLeft}%`}></span>{/if}
    <span class="playhead" data-testid="strip-playhead" style="left:50%"></span>
    <div class="ticks">
      {#each ticks as t (t.left)}<span data-testid="strip-tick" style={`left:${t.left}%`}>{t.label}</span>{/each}
    </div>
  </div>
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: 6px; position: relative; }
  .scrub { position: absolute; bottom: calc(100% + 6px); transform: translateX(-50%); z-index: 5; pointer-events: none; display: grid; gap: 2px; padding: 4px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); }
  .frame { display: block; border-radius: 4px; background-color: var(--surface-2); }
  img.frame { width: 160px; height: 90px; object-fit: cover; }
  .when { font-size: 11px; color: var(--muted); text-align: center; font-family: var(--mono); }
  .tools { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .zoom { display: flex; gap: 4px; }
  .zoom button { font-size: 12px; padding: 3px 9px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .zoom button[aria-pressed='true'] { background: var(--surface-2); color: var(--text); border-color: var(--accent); }
  .bar { position: relative; height: 46px; border-radius: 10px; background: var(--strip-empty); border: 1px solid var(--border); cursor: grab; overflow: hidden; touch-action: pan-y; user-select: none; }
  .span { position: absolute; top: 0; bottom: 0; pointer-events: none; }
  .span.stills { background: var(--surface-2); }
  .span.preview { background: var(--strip-preview); }
  .span.none { background: var(--strip-empty); }
  .span.future { background: var(--strip-future); }
  .seg { position: absolute; top: 8px; height: 18px; border-radius: 4px; background: color-mix(in srgb, var(--accent-2) 60%, transparent); pointer-events: none; }
  .seg.ai { background: var(--accent); }
  .seg.on { outline: 2px solid var(--text); outline-offset: 1px; }
  .seg.dim { opacity: 0.3; }
  .seg.failed { background: var(--no-thumb-bg); }
  .now { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--text); opacity: 0.5; pointer-events: none; }
  .playhead { position: absolute; top: -2px; bottom: -2px; width: 2px; margin-left: -1px; background: var(--accent); pointer-events: none; }
  .ticks { position: absolute; left: 0; right: 0; bottom: 2px; height: 12px; pointer-events: none; }
  .ticks span { position: absolute; transform: translateX(-50%); font-size: 10px; color: var(--muted); font-family: var(--mono); white-space: nowrap; }
</style>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run web/src/components/Strip.svelte.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Strip.svelte web/src/components/Strip.svelte.test.ts web/src/styles/theme.css
git commit -m "feat(history): centred strip bar with drag, wheel, click, zoom and spans"
```

---

### Task 5: The strip player

**Files:**
- Create: `web/src/components/StripPlayer.svelte`, `web/src/components/StripPlayer.svelte.test.ts`

**Interfaces:**
- Consumes: Task 1 (`sourceAt`, `nextChange`, `Coverage`, `Source`); `videoUrl`, `downloadUrl` from `recordings.ts`; `previewAt`, `tileStyle`, `PreviewMinute` from `timeline.ts`.
- Produces: the `<StripPlayer>` props, with `bind:at` and `bind:playing`:
  ```ts
  {
    cam: string;
    coverage: Coverage;
    previews: PreviewMinute[];
    now: number;
    at: number;          // $bindable
    playing: boolean;    // $bindable
    unavailable?: boolean;               // the camera refuses recordings (banner shown by the page)
    onclipfail: (clipId: string) => void;
    onstep: (dir: -1 | 1) => void;       // previous/next event
  }
  ```
  Test ids: `clip-video` (the active video), `strip-still`, `strip-preview`, `strip-empty`, `source-badge`, `play-toggle`, `back-10`, `fwd-10`, `prev-clip`, `next-clip`, `clip-time`, `clip-download`.
  `stillUrl(cam, ts) = /api/cameras/<cam>/stills/<ts>.jpg`.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/components/StripPlayer.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StripPlayer from './StripPlayer.svelte';
import { clipRuns, type Coverage } from '../lib/strip';
import type { EventClip } from '../lib/recordings';

const T = Date.parse('2026-09-27T12:00:00-05:00');
const clip: EventClip = { id: '20260927-120010-120020', start: new Date(T + 10_000).toISOString(), end: new Date(T + 20_000).toISOString(), durationSec: 10, triggers: ['motion'], sizeSub: 1, sizeMain: 1 };
const cov: Coverage = { clips: clipRuns([clip]), stills: [{ start: T, end: T + 30_000 }], previews: [] };

// jsdom has no media: a video "plays" when the test says so.
beforeEach(() => {
  vi.useFakeTimers({ now: T, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(function (this: HTMLMediaElement) { return Promise.resolve(); }) });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
  // Stills "load" at once.
  vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { queueMicrotask(() => this.onload?.()); } });
});
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function render(extra: Record<string, unknown> = {}) {
  const props = $state({ cam: 'den', coverage: cov, previews: [], now: T + 3_600_000, at: T, playing: false, onclipfail: vi.fn(), onstep: vi.fn(), ...extra });
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(StripPlayer, { target, props });
  flushSync();
  return props;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  flushSync();
};

describe('StripPlayer', () => {
  it('plays stills in real time and says so', async () => {
    const p = render();
    expect(q('source-badge')!.textContent).toBe('Stills 1 FPS');
    q('play-toggle')!.click();
    await tick(3000);
    expect(p.at).toBe(T + 3000);
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + 3000}.jpg`);
  });

  it('switches to the clip at its start, preloaded, and back to stills after it', async () => {
    const p = render({ playing: true, at: T + 5000 });
    await tick(2500); // within 3 s of the clip: preloading
    const vids = [...target!.querySelectorAll('video')] as HTMLVideoElement[];
    expect(vids.some((v) => v.getAttribute('src') === `/api/cameras/den/clips/${clip.id}/video`)).toBe(true);
    await tick(3000);
    expect(q('source-badge')!.textContent).toBe('SD 10 FPS');
    const video = q('clip-video') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 10 });
    video.dispatchEvent(new Event('ended'));
    flushSync();
    expect(p.at).toBe(T + 20_000);
    expect(q('source-badge')!.textContent).toBe('Stills 1 FPS');
  });

  it('marks a failing clip once and keeps playing', async () => {
    const onclipfail = vi.fn();
    render({ playing: true, at: T + 10_000, onclipfail });
    (q('clip-video') as HTMLVideoElement).dispatchEvent(new Event('error'));
    flushSync();
    expect(onclipfail).toHaveBeenCalledTimes(1);
    expect(onclipfail).toHaveBeenCalledWith(clip.id);
  });

  it('keeps the last good still when one fails', async () => {
    const bad = `/stills/${T + 2000}.jpg`;
    vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(v: string) { queueMicrotask(() => (v.endsWith(bad) ? this.onerror?.() : this.onload?.())); } });
    render({ playing: true, coverage: { clips: [], stills: [{ start: T, end: T + 30_000 }], previews: [] } });
    await tick(1000);
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + 1000}.jpg`);
    await tick(1000); // T+2000 fails to load
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + 1000}.jpg`);
    await tick(1000);
    expect(q('strip-still')!.getAttribute('src')).toBe(`/api/cameras/den/stills/${T + 3000}.jpg`);
  });

  it('shows the panel where nothing was recorded and plays through in real time', async () => {
    const p = render({ coverage: { clips: [], stills: [], previews: [] }, playing: true });
    expect(q('strip-empty')).not.toBeNull();
    expect(q('source-badge')!.textContent).toBe('No recording');
    await tick(5000);
    expect(p.at).toBe(T + 5000);
  });

  it('stops at now and never runs past it', async () => {
    const p = render({ coverage: { clips: [], stills: [], previews: [] }, playing: true, now: T + 2000 });
    await tick(10_000);
    expect(p.at).toBe(T + 2000);
    expect(p.playing).toBe(false);
    expect(q('source-badge')!.textContent).toBe('Live is on the Live page');
  });

  it('does not count time while paused, and a blocked play() leaves it paused', async () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(() => Promise.reject(new Error('NotAllowedError'))) });
    const p = render({ at: T + 10_000 });
    await tick(5000);
    expect(p.at).toBe(T + 10_000);
    q('play-toggle')!.click();
    await tick(0);
    expect(p.playing).toBe(false);
  });

  it('plays with Space and steps 10 s with the arrow keys', async () => {
    const p = render();
    const box = q('strip-player')!;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(p.at).toBe(T + 10_000);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    flushSync();
    expect(p.playing).toBe(true);
  });

  it('steps 10 s and to the previous or next event', async () => {
    const onstep = vi.fn();
    const p = render({ onstep });
    q('fwd-10')!.click();
    expect(p.at).toBe(T + 10_000);
    q('back-10')!.click();
    expect(p.at).toBe(T);
    q('next-clip')!.click();
    expect(onstep).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/components/StripPlayer.svelte.test.ts`
Expected: FAIL, "Failed to resolve import './StripPlayer.svelte'".

- [ ] **Step 3: Implement**

```svelte
<!-- web/src/components/StripPlayer.svelte -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { nextChange, sourceAt, type Coverage, type Source } from '../lib/strip';
  import { downloadUrl, videoUrl } from '../lib/recordings';
  import { previewAt, tileStyle, type PreviewMinute } from '../lib/timeline';

  // History's player (spec 2026-09-27): one clock, `at`. A clip's <video>
  // drives it while a clip plays; otherwise a real-time ticker does, showing
  // stills, preview tiles or "No recording". Two <video> elements take turns
  // so the next clip is loaded 3 s before it starts.
  let {
    cam, coverage, previews, now, at = $bindable(), playing = $bindable(), unavailable = false, onclipfail, onstep,
  }: {
    cam: string;
    coverage: Coverage;
    previews: PreviewMinute[];
    now: number;
    at: number;
    playing: boolean;
    unavailable?: boolean;
    onclipfail: (clipId: string) => void;
    onstep: (dir: -1 | 1) => void;
  } = $props();

  const TICK_MS = 250;
  const PRELOAD_MS = 3000;
  const BADGE: Record<Source['kind'], string> = {
    clip: 'SD 10 FPS', still: 'Stills 1 FPS', preview: 'Preview 1 FPS', none: 'No recording', future: 'Live is on the Live page',
  };
  const stillUrl = (ts: number) => `/api/cameras/${encodeURIComponent(cam)}/stills/${ts}.jpg`;

  const source = $derived(sourceAt(coverage, at, now));

  // --- video A/B ---
  let vids: (HTMLVideoElement | undefined)[] = $state([undefined, undefined]);
  let srcs = $state<[string | null, string | null]>([null, null]);
  let active = $state(0);
  const failedOnce = new Set<string>();
  let followVideo = false; // true while the active video drives `at`

  function urlOf(id: string) {
    return videoUrl(cam, id);
  }
  // Put the clip in the active slot (swapping when the other slot preloaded it).
  $effect(() => {
    const s = source;
    if (s.kind !== 'clip') {
      followVideo = false;
      vids[active]?.pause();
      return;
    }
    const url = urlOf(s.clip.id);
    if (srcs[active] !== url) {
      if (srcs[1 - active] === url) active = 1 - active;
      else srcs[active] = url;
    }
    const v = vids[active];
    if (!v) return;
    const want = s.offsetMs / 1000;
    if (!followVideo || Math.abs((v.currentTime || 0) - want) > 1.5) {
      try {
        v.currentTime = want;
      } catch {
        // before metadata: applied on loadedmetadata below
      }
    }
    followVideo = true;
    if (playing) void v.play().catch(() => (playing = false));
    else v.pause();
  });
  // Preload the next clip into the idle slot 3 s ahead.
  $effect(() => {
    if (!playing) return;
    const next = nextChange(coverage, at, now);
    if (next === null || next - at > PRELOAD_MS) return;
    const s = sourceAt(coverage, next, now);
    if (s.kind === 'clip' && srcs[active] !== urlOf(s.clip.id)) srcs[1 - active] = urlOf(s.clip.id);
  });
  function onVideoTime(i: number) {
    const s = source;
    if (i !== active || s.kind !== 'clip' || !followVideo) return;
    const v = vids[i]!;
    at = Date.parse(s.clip.start) + v.currentTime * 1000;
  }
  function onVideoEnded(i: number) {
    const s = source;
    if (i !== active || s.kind !== 'clip') return;
    at = Date.parse(s.clip.end);
  }
  function onVideoError(i: number) {
    const s = source;
    if (i !== active || s.kind !== 'clip' || failedOnce.has(s.clip.id)) return;
    failedOnce.add(s.clip.id);
    onclipfail(s.clip.id);
  }
  function onMeta(i: number) {
    const s = source;
    if (i === active && s.kind === 'clip') vids[i]!.currentTime = s.offsetMs / 1000;
  }

  // --- the real-time ticker (not for clips) ---
  $effect(() => {
    if (!playing) return;
    let last = Date.now();
    const id = setInterval(() => {
      const t = Date.now();
      const dt = t - last;
      last = t;
      if (source.kind === 'clip') return;
      const next = Math.min(at + dt, now);
      at = next;
      if (next >= now) playing = false;
    }, TICK_MS);
    return () => clearInterval(id);
  });

  // --- stills: shown once loaded; a failed one keeps the last good frame ---
  let stillShown = $state<string | null>(null);
  const loaded = new Set<string>();
  function loadStill(ts: number, show: boolean) {
    const url = stillUrl(ts);
    if (loaded.has(url)) {
      if (show) stillShown = url;
      return;
    }
    const img = new Image();
    img.onload = () => {
      loaded.add(url);
      if (show && source.kind === 'still' && stillUrl(source.ts) === url) stillShown = url;
    };
    img.src = url;
  }
  $effect(() => {
    const s = source;
    if (s.kind !== 'still') return;
    loadStill(s.ts, true);
    for (let k = 1; k <= 3; k++) loadStill(s.ts + k * 1000, false);
  });

  // --- preview tile, scaled up to the box ---
  let boxW = $state(0);
  const tile = $derived(source.kind === 'preview' ? previewAt(previews, source.ts) : null);

  function toggle() {
    if (source.kind === 'future') return;
    playing = !playing;
  }
  function skip(ms: number) {
    at = Math.min(now, Math.max(0, at + ms));
  }
  // Space plays or pauses; ←/→ step 10 s (spec: Player / Controls).
  function keydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) return;
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      skip(e.key === 'ArrowLeft' ? -10_000 : 10_000);
    }
  }
  const clock = $derived(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="player" data-testid="strip-player" tabindex="0" onkeydown={keydown}>
  <div class="box" bind:clientWidth={boxW}>
    {#each [0, 1] as i (i)}
      <video
        bind:this={vids[i]}
        class:hidden={source.kind !== 'clip' || i !== active}
        data-testid={i === active ? 'clip-video' : 'clip-video-idle'}
        src={srcs[i] ?? undefined}
        preload="auto"
        playsinline
        ontimeupdate={() => onVideoTime(i)}
        onended={() => onVideoEnded(i)}
        onerror={() => onVideoError(i)}
        onloadedmetadata={() => onMeta(i)}
      ></video>
    {/each}
    {#if source.kind === 'still' && stillShown}
      <img class="layer" data-testid="strip-still" src={stillShown} alt="" />
    {:else if source.kind === 'preview' && tile}
      <div class="layer tile-wrap" data-testid="strip-preview">
        <span class="tile" style={`${tileStyle(tile.minute, tile.index, 1)};transform:scale(${boxW / 160})`}></span>
      </div>
    {:else if source.kind === 'none' || source.kind === 'future'}
      <div class="layer empty" data-testid="strip-empty">
        <span>{source.kind === 'future' ? 'Live is on the Live page' : 'No recording'}</span>
        <small>{clock}</small>
      </div>
    {/if}
    <span class="badge" class:clip={source.kind === 'clip'} data-testid="source-badge">{BADGE[source.kind]}</span>
  </div>
  <div class="controls">
    <button data-testid="prev-clip" title="Previous event" onclick={() => onstep(-1)}><Icon name="prev" size={16} /></button>
    <button data-testid="back-10" title="Back 10 seconds" onclick={() => skip(-10_000)}><Icon name="back10" size={16} /><span>10</span></button>
    <button data-testid="play-toggle" class="primary" aria-pressed={playing} title={playing ? 'Pause' : 'Play'} disabled={source.kind === 'future'} onclick={toggle}>
      <Icon name={playing ? 'pause' : 'play'} size={16} />
    </button>
    <button data-testid="fwd-10" title="Forward 10 seconds" onclick={() => skip(10_000)}><span>10</span><Icon name="fwd10" size={16} /></button>
    <button data-testid="next-clip" title="Next event" onclick={() => onstep(1)}><Icon name="next" size={16} /></button>
    <span class="time" data-testid="clip-time">{clock}</span>
    {#if source.kind === 'clip' && !unavailable}
      <a class="dl" data-testid="clip-download" href={downloadUrl(cam, source.clip.id, 'main')} title="Download (full quality)"><Icon name="downloads" size={16} /></a>
    {/if}
  </div>
</div>

<style>
  .player { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .box { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; overflow: hidden; }
  video, .layer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  video.hidden { visibility: hidden; }
  .tile-wrap { overflow: hidden; }
  .tile { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .empty { display: grid; place-content: center; gap: 4px; text-align: center; color: var(--muted); background: var(--strip-empty); }
  .badge { position: absolute; top: 10px; left: 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; padding: 3px 9px; border-radius: 999px; background: var(--scrim); color: var(--on-grad); }
  .badge.clip { background: var(--accent); color: var(--accent-ink); }
  .controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .controls button, .dl { display: inline-flex; align-items: center; gap: 4px; height: 34px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; text-decoration: none; }
  .controls button.primary { background: var(--grad); color: var(--on-grad); border: none; }
  .controls button:disabled { opacity: 0.5; cursor: default; }
  .time { font-family: var(--mono); font-size: 13px; color: var(--muted); }
  .dl { margin-left: auto; }
</style>
```

The icons are the ones ClipPlayer uses today: `prev`, `back10`, `play`/`pause`, `fwd10`, `next`, `downloads`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web/src/components/StripPlayer.svelte.test.ts && npm run check`
Expected: PASS; `check` exits 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/StripPlayer.svelte web/src/components/StripPlayer.svelte.test.ts
git commit -m "feat(history): strip player (one clock, clip A/B, stills, badge)"
```

---

### Task 6: HistoryView

**Files:**
- Create: `web/src/components/HistoryView.svelte`, `web/src/components/HistoryView.svelte.test.ts`

**Interfaces:**
- Consumes: Task 2 (`createStripData`, `StripData`), Task 4 (`Strip`), Task 5 (`StripPlayer`); `localDate`, `thumbUrl`, `EventClip` from `recordings.ts`; `windowAround` from Task 1; the `zoom` store from Task 3.
- Produces: the `<HistoryView>` props and one method (via `bind:this`):
  ```ts
  props: {
    cam: string;
    proxy: boolean;
    date: string;                 // the page's date (URL); a change that disagrees with `at` jumps
    initialAt: number | null;     // from the URL; null: the day's first event, else 00:00
    visibleIds: ReadonlySet<string>;
    unavailable: boolean;
    onposition: (at: number, clipId: string | null) => void; // at once on jumps, else at most every 2 s
  }
  method: jump(at: number, play?: boolean): void
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/components/HistoryView.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HistoryView from './HistoryView.svelte';
import { resetDayCache } from '../lib/dayCache';
import { preferences } from '../lib/preferences';

// TZ=America/Chicago; the clock is 2026-09-27 20:00 CDT.
const NOW = Date.parse('2026-09-27T20:00:00-05:00');
const E1 = { id: '20260927-081510-081535', start: '2026-09-27T13:15:10.000Z', end: '2026-09-27T13:15:35.000Z', durationSec: 25, triggers: ['person'], sizeSub: 1, sizeMain: 1 };
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
beforeEach(() => {
  resetDayCache();
  preferences.set({ defaultCamera: null, liveQuality: 'sub', eventFilter: 'all', timelineZoom: 1, liveKeepAlive: 60 });
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('fetch', async (url: string) => {
    const body = url.includes('/events?date=2026-09-27') ? { events: [E1], downloads: 'ok' } : url.includes('/events?') ? { events: [], downloads: 'ok' } : [];
    return new Response(JSON.stringify(body), { status: 200 });
  });
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  preferences.set(null);
});
async function render(extra: Record<string, unknown> = {}) {
  const onposition = vi.fn();
  const props = $state({ cam: 'den', proxy: false, date: '2026-09-27', initialAt: null as number | null, visibleIds: new Set<string>(), unavailable: false, onposition, ...extra });
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(HistoryView, { target, props });
  await vi.advanceTimersByTimeAsync(10);
  flushSync();
  return { props, onposition };
}

describe('HistoryView', () => {
  it('opens on the day’s first event when the URL has no position', async () => {
    const { onposition } = await render();
    expect(onposition).toHaveBeenLastCalledWith(Date.parse(E1.start), E1.id);
  });

  it('opens at the URL position', async () => {
    const at = Date.parse('2026-09-27T10:00:00-05:00');
    const { onposition } = await render({ initialAt: at });
    expect(onposition).toHaveBeenLastCalledWith(at, null);
  });

  it('jumps when the page’s date changes to another day, to 00:00 without events', async () => {
    const { props, onposition } = await render();
    props.date = '2026-09-25';
    await vi.advanceTimersByTimeAsync(10);
    flushSync();
    expect(onposition).toHaveBeenLastCalledWith(new Date(2026, 8, 25).getTime(), null);
  });

  it('reports the position at most every 2 s while playing', async () => {
    const at = Date.parse('2026-09-27T10:00:00-05:00');
    const { onposition } = await render({ initialAt: at });
    onposition.mockClear();
    (target!.querySelector('[data-testid="play-toggle"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onposition.mock.calls.length).toBeLessThanOrEqual(3);
    expect(onposition.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/components/HistoryView.svelte.test.ts`
Expected: FAIL, "Failed to resolve import './HistoryView.svelte'".

- [ ] **Step 3: Implement**

```svelte
<!-- web/src/components/HistoryView.svelte -->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Strip from './Strip.svelte';
  import StripPlayer from './StripPlayer.svelte';
  import { createStripData, type StripData } from '../lib/stripData';
  import { EMPTY_COVERAGE, windowAround, type Coverage } from '../lib/strip';
  import { localDate, thumbUrl, type EventClip } from '../lib/recordings';
  import type { PreviewMinute } from '../lib/timeline';
  import { zoom } from '../lib/zoomPref';

  // History's strip and player (spec 2026-09-27). Owns the position `at`;
  // the page only hears about it (onposition) and can jump it (jump()).
  let {
    cam, proxy, date, initialAt, visibleIds, unavailable, onposition,
  }: {
    cam: string;
    proxy: boolean;
    date: string;
    initialAt: number | null;
    visibleIds: ReadonlySet<string>;
    unavailable: boolean;
    onposition: (at: number, clipId: string | null) => void;
  } = $props();

  let now = $state(Date.now());
  const nowTimer = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(nowTimer));

  let data: StripData = $state(createStripData(untrack(() => cam), untrack(() => proxy)));
  let coverage: Coverage = $state(EMPTY_COVERAGE);
  let previews: PreviewMinute[] = $state([]);
  let failed = $state(new Set<string>());
  $effect(() => {
    const d = createStripData(cam, proxy);
    data = d;
    failed = new Set();
    const u1 = d.coverage.subscribe((c) => (coverage = c));
    const u2 = d.previews.subscribe((p) => (previews = p));
    return () => {
      u1();
      u2();
      d.destroy();
    };
  });

  let at = $state(untrack(() => initialAt) ?? new Date(untrack(() => date).replace(/-/g, '/')).getTime());
  let playing = $state(false);
  let placed = untrack(() => initialAt) !== null; // false: move to the day's first event once it loads
  let dragResume = false;

  const events: EventClip[] = $derived(coverage.clips.map((c) => c.clip));
  const current = $derived(coverage.clips.find((c) => at >= c.start && at < c.end)?.clip.id ?? null);

  // Load what the window (and one day either side) needs, and stills around the playhead.
  $effect(() => {
    const w = windowAround(at, $zoom);
    untrack(() => data.ensure(w.start, w.end));
  });
  $effect(() => {
    const hour = Math.floor(at / 3_600_000);
    untrack(() => data.ensureStills(hour * 3_600_000));
  });

  // First position without one in the URL: the day's first event, else 00:00.
  $effect(() => {
    void coverage;
    if (placed) return;
    const list = data.eventsOn(date);
    if (list === null) return;
    placed = true;
    at = list.length ? Date.parse(list[0].start) : dayStart(date);
    report(true);
  });

  // The page changed the date (day picker) to a day the playhead isn't on.
  let lastDate = untrack(() => date);
  $effect(() => {
    const d = date;
    if (d === lastDate) return;
    lastDate = d;
    untrack(() => {
      if (localDate(new Date(at)) === d) return;
      playing = false;
      placed = false;
      at = dayStart(d);
      report(true);
    });
  });

  function dayStart(d: string) {
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(y, m - 1, dd).getTime();
  }

  // Position reports: at once for jumps, else at most every 2 s.
  let lastReport = 0;
  function report(force = false) {
    const t = Date.now();
    if (!force && t - lastReport < 2000) return;
    lastReport = t;
    onposition(at, current);
  }
  $effect(() => {
    void at;
    untrack(() => report(false));
  });
  $effect(() => {
    void current;
    untrack(() => report(true));
  });

  export function jump(t: number, play = false) {
    at = Math.min(t, now);
    placed = true;
    if (play) playing = true;
    report(true);
  }
  function step(dir: -1 | 1) {
    const list = coverage.clips;
    const target = dir > 0 ? list.find((c) => c.start > at + 500) : [...list].reverse().find((c) => c.start < at - 1500);
    if (target) jump(target.start, playing);
  }
</script>

<div class="history">
  <StripPlayer {cam} {coverage} {previews} {now} bind:at bind:playing {unavailable}
    onclipfail={(id) => {
      data.markFailed(id);
      failed = new Set(failed).add(id);
    }}
    onstep={step} />
  <Strip {coverage} {events} {visibleIds} failedIds={failed} {at} {now} currentId={current} {previews}
    thumbFor={unavailable ? undefined : (id) => thumbUrl(cam, id)}
    onseek={(t) => jump(t)}
    ondrag={(active) => {
      if (active) {
        dragResume = playing;
        playing = false;
      } else if (dragResume) playing = true;
    }}
    onstep={step} />
</div>

<style>
  .history { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
</style>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web/src/components/HistoryView.svelte.test.ts && npm run check`
Expected: PASS; `check` exits 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/HistoryView.svelte web/src/components/HistoryView.svelte.test.ts
git commit -m "feat(history): HistoryView owns the position, wires strip and player"
```

---

### Task 7: Recordings page on the strip; old code out

**Files:**
- Modify: `web/src/lib/recordings.ts` (`Cursor.at`, `parseCursor`, `cursorSearch`)
- Modify: `web/src/lib/recordings.test.ts` (parse and write `at`)
- Modify: `web/src/pages/Recordings.svelte` (use `HistoryView`, `dayCache`, `at`)
- Modify: `web/src/components/Timeline.svelte` (remove History-only code), `web/src/components/Timeline.svelte.test.ts`
- Delete: `web/src/components/ClipPlayer.svelte` (and its test file, if any: `ls web/src/components/ClipPlayer*`)
- Modify: `e2e/recordings.spec.ts`, `e2e/timeline.spec.ts`

**Interfaces:**
- Consumes: Task 2 (`loadDay`), Task 6 (`HistoryView` with `jump`), Task 1 (`clipStartFromId`).
- Produces:
  - `Cursor = { date: string; clipId: string | null; offsetSec: number; at: number | null }`.
  - `parseCursor` reads `at` (`/^\d{12,14}$/`).
  - `cursorSearch` writes `cam`, `date`, then `at` when set, else `clip`/`t` as before. It writes `clip` (the clip under the playhead) whenever `clipId` is set, then `panel`, `filter`.

- [ ] **Step 1: Write the failing tests** (in `web/src/lib/recordings.test.ts`)

```ts
describe('the strip position in the URL', () => {
  it('reads at, and old links without it', () => {
    const p = parseCursor(new URLSearchParams('cam=den&date=2026-09-27&at=1790552160000&clip=20260927-120505-120530'), '2026-09-27');
    expect(p.cursor.at).toBe(1790552160000);
    const old = parseCursor(new URLSearchParams('cam=den&date=2026-09-27&clip=20260927-120505-120530&t=7'), '2026-09-27');
    expect(old.cursor).toEqual({ date: '2026-09-27', clipId: '20260927-120505-120530', offsetSec: 7, at: null });
  });

  it('writes at and the clip under the playhead, no t', () => {
    const s = cursorSearch('den', { date: '2026-09-27', clipId: '20260927-120505-120530', offsetSec: 0, at: 1790552160000 }, 'history', 'all');
    expect(s).toBe('?cam=den&date=2026-09-27&at=1790552160000&clip=20260927-120505-120530&panel=history&filter=all');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/lib/recordings.test.ts`
Expected: FAIL (`at` is undefined; the search has `t=`).

- [ ] **Step 3: Implement the URL helpers** (`web/src/lib/recordings.ts`)

```ts
export interface Cursor {
  date: string;
  clipId: string | null;
  offsetSec: number;
  at: number | null; // the strip position (UTC ms); null: from clipId/offsetSec, or the day's first event
}
```

In `parseCursor`, add `const atRaw = params.get('at') ?? '';` and add to the returned cursor: `at: /^\d{12,14}$/.test(atRaw) ? Number(atRaw) : null,`.

Replace `cursorSearch` with:

```ts
export function cursorSearch(c: string, cursor: Cursor, panel: string, filter: Filter): string {
  const p = new URLSearchParams({ cam: c, date: cursor.date });
  if (cursor.at !== null) p.set('at', String(Math.floor(cursor.at)));
  if (cursor.clipId) p.set('clip', cursor.clipId);
  if (cursor.at === null) p.set('t', String(Math.floor(cursor.offsetSec)));
  p.set('panel', panel);
  p.set('filter', filter);
  return `?${p.toString()}`;
}
```

Fix every other `Cursor` literal to carry `at`. `npm run check` lists them: `Live.svelte:173` (`at: null`) and the `Recordings.svelte` ones below. Update older tests that build a `Cursor` object with `at: null` as the compiler asks.

- [ ] **Step 4: Rewire `Recordings.svelte`**

1. Imports. Remove `ClipPlayer`, `Timeline`, `clipAtSecond`, `secondsIntoDay`, `neighbour` (if now unused), `videoUrl`, `thumbUrl`, `downloadUrl`, the `PreviewMinute`/`dayRange`/`splitRange` import, and the `previews` effect (lines 83–97). Add:
   ```ts
   import HistoryView from '../components/HistoryView.svelte';
   import { loadDay } from '../lib/dayCache';
   import { clipStartFromId } from '../lib/strip';
   ```
2. The events effect: replace `getJson<{ events: EventClip[]; downloads?: … }>(eventsUrl(c, d))` with `loadDay(c, d, { force: isRefresh })`. It returns `{ events, downloads }`, and the `.then` body stays the same except that `e.downloads` is always set. Do the same in `recheckDownloads`: `loadDay(c, cursor.date, { force: true }).then((r) => { if (c === cam) downloads = r.downloads; })`.
3. Position state:
   ```ts
   let historyView: { jump: (at: number, play?: boolean) => void } | undefined = $state();
   let playheadClip: string | null = $state(null);
   const initialAt = $derived(
     cursor.at ?? (cursor.clipId ? (clipStartFromId(cursor.clipId) ?? 0) + cursor.offsetSec * 1000 || null : null),
   );
   function onPosition(at: number, clipId: string | null) {
     playheadClip = clipId;
     if (!cam) return;
     const c: Cursor = { date: localDate(new Date(at)), clipId, offsetSec: 0, at };
     saveCursor(cam, c);
     replaceRoute(`/app/recordings${cursorSearch(cam, c, panel, filter)}`);
   }
   ```
4. Delete `onTime`, `pickSecond`, `step`, `stepDay` and `jumpToEdge`, and the `selected` derived value if it is unused after this.
5. The day picker: `onchange={(d) => go({ date: d, clipId: null, offsetSec: 0, at: null })}`.
6. The main column. Replace the `<ClipPlayer …/>` and the `<Timeline …/>` block with this (the notes, banners, skeleton and "no recordings" note stay; only the `{:else}` branch that rendered `Timeline` goes):
   ```svelte
   {#key cam}
     <HistoryView bind:this={historyView} cam={cam!} proxy={!!$cameras.find((x) => x.id === cam)?.proxy}
       date={cursor.date} {initialAt} visibleIds={new Set(visible.map((e) => e.id))}
       unavailable={downloads === 'unavailable'} onposition={onPosition} />
   {/key}
   ```
   The strip is shown even for a day without recordings (the page's "No recordings on …" note stays under it).
7. The side lists: `EventList … selectedId={playheadClip} onselect={(e) => historyView?.jump(Date.parse(e.start), true)}`, and `DownloadList … selectedId={playheadClip}`.
8. The restore-on-load effect (`go({}, {}, 'replace')`) stays. It now writes `at` only once HistoryView reports.

- [ ] **Step 5: Trim `Timeline.svelte` to Live's legend use**

Live renders `<Timeline … compact legend now=… testid="live-timeline" {updatedAt} />`. Remove from `Timeline.svelte`:
- the `carry` module script;
- the `onday` and `thumbFor` props;
- the hover code (`REST_MS`, `hover`, `move`, `leave`, `imgFailed`, `pendingImg`, `brokenImgs`) and the `scrub` markup;
- `chosen`, `pickZoom`, `saving`, `panStart`, both pan effects, `pan`, `rangeLabel`, `cover`, the `.tools` markup and their styles;
- the `previews` and `dayStartMs` props.

`zoom` becomes the constant `24` (`const win = $derived(timelineWindow(24, center, daySec))`). In `Timeline.svelte.test.ts`, delete the tests for those features. Keep only tests that use `compact`/`legend` (if none remain, keep one: it renders segments, and clicking one calls `onpick`, using the existing props).

Run: `grep -rn "previews=\|thumbFor=\|onday=\|timeline-range\|timeline-prev" web/src`
Expected: no hits outside `Strip.svelte`/`HistoryView.svelte`.

- [ ] **Step 6: Update the History e2e tests** (`e2e/recordings.spec.ts`, `e2e/timeline.spec.ts`)

The test ids are unchanged. Behaviour changes: the page opens on the day's first event, **paused**; clicking an event plays it; the URL carries `at` and `clip`.
- 'selecting an event plays it and puts it in the URL': unchanged (`clip=` is still written; `clip-video` plays).
- 'skip, pause and next/previous recording work': unchanged.
- 'clicking the timeline selects the recording under the click': select the segment by id, not position:
  ```ts
  const seg = page.locator('[data-testid="timeline-seg"][data-clip-id$="-120505-120530"]');
  ```
  Then click its centre with `page.mouse.click` on the bounding box, and expect `/clip=\d{8}-120505-120530/`.
- 'ArrowRight with no clip selected selects the first clip': rename it to 'History opens on the day's first recording' and replace the body:
  ```ts
  await page.goto('/app/recordings?panel=history');
  await expect(page).toHaveURL(/clip=\d{8}-081510-081535/);
  ```
- 'zoom is kept when an event card is clicked, and across pages': drop the `timeline-range` lines and the ‹ step. Keep the zoom and page-switch checks with `zoom-3` instead of `zoom-1`.
- Delete '‹ from the first hour opens the previous day …' (the feature is gone).
- 'clip clicks do not re-fetch the day's events': add `await page.waitForLoadState('networkidle');` right after `openEvents(page)`, before the listener is attached. The strip's own day loads (one day either side) land first.
- `e2e/timeline.spec.ts`, 'the Recordings timeline previews the frame under the pointer': open History at a position two minutes ago, and hover the bar's centre (the playhead):
  ```ts
  const at = Date.now() - 120_000;
  await page.goto(`/app/recordings?cam=cam1&panel=history&at=${at}`);
  const bar = page.getByTestId('timeline');
  await expect(bar).toBeVisible();
  const box = (await bar.boundingBox())!;
  await expect.poll(async () => {
    await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2);
    return page.getByTestId('scrub-preview').isVisible();
  }, { timeout: 10_000 }).toBe(true);
  ```

- [ ] **Step 7: Run everything**

Run: `npm test && npm run build && npm run check && npx playwright test`
Expected: all pass. Playwright: 0 failed.

- [ ] **Step 8: Commit**

```bash
git add -A web/src e2e
git commit -m "feat(history): Recordings on the continuous strip; at in the URL; old player and pan code removed"
```

(`git add -A web/src e2e` stages the deletion of `ClipPlayer.svelte` too. Check `git status` first; nothing outside `web/src` and `e2e` may be staged.)

---

### Task 8: Fixtures, e2e for the strip, the Timeline page link, docs

**Files:**
- Modify: `e2e/fakeProxyData.ts` (Barn stills every second for the last 15 minutes)
- Modify: `e2e/recordings.spec.ts` (new strip tests)
- Modify: `web/src/pages/Timeline.svelte` (an "Open in History" link in the viewer)
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above; the fake proxy's `stills` map (`cam → ts → jpeg`).
- Produces: e2e coverage for the source badge, drag across midnight, old links and the phone layout.

- [ ] **Step 1: Fixture: Barn stills at 1 per second**

In `e2e/fakeProxyData.ts`, replace the Barn stills loop (`for (let t = now - 10 * 60_000; t <= now + 60 * 60_000; t += 5000) barn.set(t, jpeg);`) with:

```ts
  // One still per second for the last 15 minutes, as the real proxy keeps them
  // (the History strip plays them at 1 fps).
  for (let t = now - 15 * 60_000; t <= now; t += 1000) barn.set(t, jpeg);
```

- [ ] **Step 2: Write the new e2e tests** (`e2e/recordings.spec.ts`)

```ts
// The continuous strip (spec 2026-09-27).
test('the strip plays proxy stills in real time, and says so', async ({ page }) => {
  const at = Date.now() - 5 * 60_000;
  await page.goto(`/app/recordings?cam=barn&panel=history&at=${at}`);
  await expect(page.getByTestId('source-badge')).toHaveText('Stills 1 FPS');
  await expect.poll(() => page.getByTestId('strip-still').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const before = new URL(page.url()).searchParams.get('at');
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('at'), { timeout: 10_000 }).not.toBe(before);
});

test('a stretch with nothing recorded says so', async ({ page }) => {
  const d = new Date();
  const earlyToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 1).getTime(); // Shed: no proxy, no event at 00:01
  await page.goto(`/app/recordings?cam=shed&panel=history&at=${earlyToday}`);
  await expect(page.getByTestId('source-badge')).toHaveText('No recording');
  await expect(page.getByTestId('strip-empty')).toBeVisible();
});

test('dragging the strip to yesterday changes the date and the list', async ({ page }) => {
  const d = new Date();
  const earlyToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 30).getTime();
  await page.goto(`/app/recordings?panel=history&at=${earlyToday}`);
  await page.getByTestId('zoom-3').click();
  const bar = page.getByTestId('timeline');
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.95, box.y + 20, { steps: 8 }); // ~1.35 h back
  await page.mouse.up();
  const today = await page.evaluate(() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; });
  await expect.poll(() => new URL(page.url()).searchParams.get('date')).not.toBe(today);
  await expect(page.getByTestId('day-picker')).not.toHaveValue(today);
});

test('an old link with clip and t opens at that moment', async ({ page }) => {
  await openEvents(page);
  const id = await page.getByTestId('event-card').nth(2).getAttribute('data-clip-id');
  const date = new URL(page.url()).searchParams.get('date');
  await page.goto(`/app/recordings?date=${date}&clip=${id}&t=3&panel=history`);
  await expect(page.locator('[data-testid="event-card"][aria-current="true"]')).toHaveAttribute('data-clip-id', id!);
  await expect(page.getByTestId('source-badge')).toHaveText('SD 10 FPS');
});

test('on a phone the strip and controls fit the width', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout');
  await page.goto('/app/recordings?panel=history');
  await expect(page.getByTestId('timeline')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
```

(`openEvents` is already defined at the top of the file.)

- [ ] **Step 3: Run the new tests to see them fail, then pass**

Run: `npx playwright test e2e/recordings.spec.ts -g "strip|nothing recorded|dragging|old link|phone"`
Expected before Step 1's fixture change: 'the strip plays proxy stills' fails (5 s gaps give short runs between the stills). After it: all pass. If the drag test's date doesn't change within one drag at 3 h, drag twice. Ruling: a second drag is fine; the test is about crossing midnight, not the drag distance.

- [ ] **Step 4: "Open in History" on the Timeline page**

In `web/src/pages/Timeline.svelte`, in the still viewer's header (next to `timeline-close`), add:

```svelte
<a data-testid="timeline-open-history" href={`/app/recordings?cam=${encodeURIComponent(camera.id)}&panel=history&at=${ts}`}>Open in History</a>
```

Put it inside `<div class="bar">` next to the `timeline-close` button; `ts` is the `{@const ts = open.stills[open.i]}` just above, and `camera` is the page's selected camera. Add to `e2e/timeline.spec.ts`'s first test, before closing the viewer:

```ts
  await expect(page.getByTestId('timeline-open-history')).toHaveAttribute('href', /panel=history&at=\d+/);
```

- [ ] **Step 5: Docs**

In `CHANGELOG.md` under `## [Unreleased]`:

```markdown
- History is one continuous strip: the playhead stays in the centre (24, 12,
  6, 3 or 1 h) and playback runs in real time through clips (SD), the
  camera gateway's stills (1 fps), preview tiles and stretches with nothing
  recorded, across midnight. A badge on the video names the source. Drag,
  scroll sideways or click the strip to move; the URL keeps the moment
  (`at`), and old links still work. The ‹ › window buttons are gone.
- The Timeline page links a still to that moment in History.
```

In `README.md`, in the Pages bullet, replace `Recordings with the History, Events and Downloads panels (\`?panel=\`, \`?cam&date&clip&t\`)` with `Recordings with the History strip and the Events and Downloads panels (\`?panel=\`, \`?cam&date&at\`, old \`clip&t\` links still work)`. In the cam-proxy bullets, replace the "Scrub preview" bullet with:

```markdown
  - **History strip:** the playhead stays centred and playback runs in real time through clips, the proxy's stills (1 fps, 24 h) and preview tiles (1 fps, 72 h), and stretches without anything ("No recording"), across days; a badge names the source.
```

- [ ] **Step 6: Run everything**

Run: `npm test && npm run build && npm run check && npx playwright test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add e2e/fakeProxyData.ts e2e/recordings.spec.ts e2e/timeline.spec.ts web/src/pages/Timeline.svelte README.md CHANGELOG.md
git commit -m "test(history): strip e2e, stills fixture; Timeline links to History; docs"
```
