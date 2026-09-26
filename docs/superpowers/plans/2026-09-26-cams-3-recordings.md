# cams Plan 3: Recordings Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Recordings workspace. A day timeline and an event list with thumbnails show every recorded clip from the last 7 days. Clicking one plays it, with play/pause, ±10 s and previous/next clip, and any clip downloads in sub or full quality. One shared time cursor links History, Events and Downloads, and the URL records it. The Live page gains a mini timeline of today's events, and fullscreen starts working on phones.

**Architecture:**
- The server lists recordings through two new ReolinkClient calls:
  - `Search` for one day (clips) or one month (the days that have recordings).
  - `GetTime`, used to turn camera-local times into exact ISO times.
- The server decodes each clip's trigger (person, vehicle, pet, motion) from its file name.
- Clips are addressed by an opaque id derived from their times, never by a camera path.
- The server fetches sub-stream clips once into a disk cache (emptyDir, LRU-capped). It serves them with HTTP Range so `<video>` can seek, and makes thumbnails from them with ffmpeg.
- Full-quality downloads stream straight through.
- The web UI:
  - Keeps the cursor in the URL and a session store.
  - Builds on pure, unit-tested helpers: timeline layout, nearest clip, cursor parse/serialise.
  - Is responsive: side panel on desktop, panel below on tablet, stacked on phones.

**Tech Stack:** as in Plans 1–2, plus `ffmpeg` in the runtime image (Alpine package) for thumbnails.

**Spec:** `docs/superpowers/specs/2026-09-25-cams-design.md`:
- §2 camera facts (recordings)
- §3 media paths, caching, clip IDs, recordings and events model
- §5 Recordings workspace, shared time cursor, Live mini timeline
- §6 errors
- §7 tests

**Carried in:**
- The mobile fullscreen fix (Klaus reported it after Plan 2; Task 0).
- The follow-ups files stay open: `2026-09-25-cams-1-followups.md` and `2026-09-26-cams-2-followups.md`.

## Camera facts this plan relies on (measured 2026-09-26, fw v3.2.0.6011)

**`Search`** is a POST command, token in the query.

Month overview:
```
{"Search":{"channel":0,"onlyStatus":1,"streamType":"main","StartTime":{…},"EndTime":{…}}}
```
It returns `value.SearchResult.Status[] = {year, mon, table}`, where `table` has one character per day (index 0 = day 1) and `'1'` means that day has recordings.

Day files: the same with `"onlyStatus":0`, `streamType` `"main"` or `"sub"`, and times from 00:00:00 to 23:59:59. It returns `value.SearchResult.File[] = {name, size (string), StartTime{…}, EndTime{…}, type}`. A day with no clips has no `File` key.

**Clip names** look like `/mnt/sda/Mp4Record/2026-09-25/RecS0A_DST20260925_125653_125718_0_55148080000000_927C9.mp4`:

| Part | Meaning |
|---|---|
| `Rec` + `M`/`S` | main or sub stream |
| two hex digits | name version (`0A` = 10) |
| optional `DST` | daylight saving was active; this settles the UTC offset |
| `YYYYMMDD_HHMMSS_HHMMSS` | camera-local start date, start time and end time |
| next field | animal type (ignored) |
| 14-hex-digit field | flags |
| last field | size (hex) |

**Flag decoding** for version 9 and 10, 14 hex digits, as in the `reolink_aio` library. Reverse the hex's 56-bit binary; then these single-bit fields sit at the given reversed positions:

| Flag | Reversed position |
|---|---|
| person | 17 |
| vehicle | 19 |
| pet | 20 |
| schedule (timer) | 23 |
| motion | 24 |

Equivalently, test bit `(55 − pos)` of the original number. Verified vectors:

| Flags | Triggers |
|---|---|
| `55148080000000` | motion (a real sub clip) |
| `7B288280000000` | motion (a real main clip) |
| `5514C000000000` | person |
| `55149000000000` | vehicle |
| `55148800000000` | pet |

Today the camera records on motion only; its AI record schedule is off. Plan 4's settings cover that.

**Download:** `GET /cgi-bin/api.cgi?cmd=Download&source=<full name>&output=<x>.mp4&token=<t>` returns `200 video/mp4`. It is a fragmented MP4 that a browser can seek.
- It needs camera HTTP and RTMP enabled; both are on.
- **With a bad token it returns HTTP 401 `text/html` with an empty body.** This is a fourth rejection shape: the client currently treats only 403 as a rejection.

**Time:** `GetTime` returns:
- `value.Time.timeZone`: seconds **west** of UTC, 21600 = UTC−6;
- `value.Dst.enable` and `value.Dst.offset` (hours, here 1).

A clip's UTC offset in minutes is `−timeZone/60 + (DST in name ? Dst.offset × 60 : 0)`. For Chicago in summer that is −300, so `…T12:56:53-05:00`.

**Sizes:** sub clips are about 0.3–1.5 MB, main clips about 4–17 MB, and clips last 20–60 s.

## Global Constraints

- Everything in Plans 1–2's Global Constraints still applies (Node 26, auth, logging, token handling, error codes and so on).
- **Clip identity:**
  - Clip id = `YYYYMMDD-HHMMSS-HHMMSS`, camera-local start date, start and end, matching `^\d{8}-\d{6}-\d{6}$`.
  - The server resolves ids only through its own `Search` results and **never accepts a camera path from the client**.
  - Unknown clip → `404 {"error":"unknown_clip"}`. Malformed id or date → `400 {"error":"bad_request"}`.
- **API routes** (all behind `/api` auth):

| Route | Response |
|---|---|
| `GET /api/cameras/:id/days?month=YYYY-MM` | `{ days: string[] }` (YYYY-MM-DD) |
| `GET /api/cameras/:id/events?date=YYYY-MM-DD` | `{ date, events: EventClip[] }`, sorted by start |
| `GET /api/cameras/:id/clips/:clipId/video` | sub MP4 from cache, with Range support |
| `GET /api/cameras/:id/clips/:clipId/thumb.jpg` | JPEG from cache |
| `GET /api/cameras/:id/clips/:clipId/download?quality=sub\|main` | attachment `<cameraId>-<YYYY-MM-DD>_<HH-MM-SS>-<quality>.mp4` |

- **`EventClip`** = `{ id, start, end, durationSec, triggers: ('person'|'vehicle'|'pet'|'motion'|'timer')[], sizeSub: number|null, sizeMain: number|null }`. `start` and `end` are ISO 8601 with offset.
- **Caching:**
  - Search results: 30 s for today (camera-local), 10 min for past days.
  - Month status: 5 min.
  - `GetTime`: 1 h.
- **Disk cache:**
  - Lives at `CACHE_DIR` (default `os.tmpdir()/cams-cache`), total capped at `CACHE_MAX_BYTES` (default 1.5 GiB), least-recently-used files evicted first.
  - Files are written to a temp name and renamed, so a half-written file is never served.
  - Concurrent requests for the same clip share one fetch.
- **Camera load:**
  - At most **2 concurrent recording transfers per camera** (clip fetch or download). This is separate from the 2-slot API gate.
  - A transfer holds its slot until its stream ends or closes.
- **Thumbnails:**
  - `ffmpeg -ss 1 -i <sub.mp4> -frames:v 1 -vf scale=320:-2 -q:v 5 <out.jpg>` (path from `FFMPEG_PATH`, default `ffmpeg`), with a 15 s timeout.
  - Failure → `503 {"error":"thumbnail_unavailable"}`; the UI shows a placeholder.
- **Shared cursor and URL:**
  - `/app/recordings?cam=<id>&date=<YYYY-MM-DD>&clip=<clipId>&t=<seconds into clip>&panel=<history|events|downloads>&filter=<all|person|vehicle|pet|motion>`.
  - The last cursor is kept in `sessionStorage` under `cams-cursor` (try/catch), so the sidebar's History/Events/Downloads links reopen it.
- **Timeline zoom levels:** 24 h, 6 h, 1 h. The window centres on the selected clip.
- **Colours:** AI-triggered clips use `--accent`; motion-only clips use `--accent-2` at 60 % mix.
- **Test ids used by e2e:**
  - `day-picker`, `day-prev`, `day-next`, `no-recordings`
  - `timeline`, `timeline-seg` (with `data-clip-id`), `zoom-24`, `zoom-6`, `zoom-1`
  - `clip-video`, `play-toggle`, `back-10`, `fwd-10`, `prev-clip`, `next-clip`, `clip-time`
  - `event-card` (with `data-clip-id`, and `aria-current` when selected), `event-thumb`, `filter-<all|person|vehicle|pet|motion>`
  - `download-row`, `download-sub`, `download-main`
  - `live-timeline`

## Review Focus

1. **A path-traversal or arbitrary-file request through clip ids** (`../`, encoded slashes, other camera's clip) must be impossible: ids are validated by regex and resolved only through that camera's own Search results. Pinned in Task 3.
2. **A clip requested again while it is still being fetched** (double click, the video element's own range requests) must share one camera transfer, not start two. A failed fetch must not leave a partial file in the cache. Pinned in Task 3.
3. **Day boundaries and DST:**
   - A clip that starts before midnight and ends after must still have `end > start`.
   - The DST flag in the name must decide the offset, even on the night the clocks change.
   - Pinned in Task 1.
4. **The cache filling up:** eviction must keep total bytes under the cap and must not delete a file that is currently being served. Pinned in Task 3.
5. **A day with no recordings, or a camera with the AI schedule off** (motion only), must show a clear empty state, not a spinner or an error. Pinned in Tasks 6 and 7.

---

### Task 0: Fullscreen on phones

**Files:**
- Create: `web/src/lib/fullscreen.ts`, `web/src/lib/fullscreen.test.ts`
- Modify: `web/src/pages/Live.svelte`

**Interfaces:**
- Produces `enterFullscreen(container: HTMLElement | undefined, video: HTMLVideoElement | null): Promise<'container' | 'video' | 'none'>`.

- [ ] **Step 1: Failing test `web/src/lib/fullscreen.test.ts`**

```ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { enterFullscreen } from './fullscreen';

describe('enterFullscreen', () => {
  it('uses the container when the Fullscreen API is available', async () => {
    const container = document.createElement('div');
    container.requestFullscreen = vi.fn(async () => {});
    expect(await enterFullscreen(container, document.createElement('video'))).toBe('container');
    expect(container.requestFullscreen).toHaveBeenCalled();
  });

  // iPhone Safari: no element fullscreen, only the video's own player.
  it('falls back to the video element (webkitEnterFullscreen) when the container cannot go fullscreen', async () => {
    const container = document.createElement('div');
    (container as unknown as { requestFullscreen?: unknown }).requestFullscreen = undefined;
    const video = document.createElement('video') as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    video.webkitEnterFullscreen = vi.fn();
    expect(await enterFullscreen(container, video)).toBe('video');
    expect(video.webkitEnterFullscreen).toHaveBeenCalled();
  });

  it('falls back to the video when requestFullscreen rejects', async () => {
    const container = document.createElement('div');
    container.requestFullscreen = vi.fn(async () => { throw new Error('not allowed'); });
    const video = document.createElement('video') as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    video.webkitEnterFullscreen = vi.fn();
    expect(await enterFullscreen(container, video)).toBe('video');
  });

  it('reports none when nothing can go fullscreen', async () => {
    const container = document.createElement('div');
    (container as unknown as { requestFullscreen?: unknown }).requestFullscreen = undefined;
    expect(await enterFullscreen(container, null)).toBe('none');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run web/src/lib/fullscreen.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement `web/src/lib/fullscreen.ts`**

```ts
type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void };

// Desktop browsers put the whole viewer (video + controls) into fullscreen.
// iPhone Safari has no element fullscreen at all; only the <video>'s own
// native player can go fullscreen there, via webkitEnterFullscreen.
export async function enterFullscreen(
  container: HTMLElement | undefined,
  video: HTMLVideoElement | null,
): Promise<'container' | 'video' | 'none'> {
  const el = container as WebkitElement | undefined;
  try {
    if (el?.requestFullscreen) {
      await el.requestFullscreen();
      return 'container';
    }
    if (el?.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
      return 'container';
    }
  } catch {
    // fall through to the video element
  }
  const v = video as WebkitVideo | null;
  if (v?.webkitEnterFullscreen) {
    v.webkitEnterFullscreen();
    return 'video';
  }
  if (v?.requestFullscreen) {
    try {
      await v.requestFullscreen();
      return 'video';
    } catch {
      return 'none';
    }
  }
  return 'none';
}
```

- [ ] **Step 4: Use it in `web/src/pages/Live.svelte`**

Replace the `fullscreen()` function with:
```ts
  import { enterFullscreen } from '../lib/fullscreen';

  function fullscreen() {
    const video = container?.querySelector<HTMLVideoElement>('[data-testid="live-video"]') ?? null;
    void enterFullscreen(container, video);
  }
```
Keep the import next to the other imports.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run 2>&1 | tail -4 && npm run build && npm run check`. Everything should be green with no warnings.
```bash
git add web/src/lib/fullscreen.ts web/src/lib/fullscreen.test.ts web/src/pages/Live.svelte
git commit -m "fix: fullscreen on phones falls back to the video element"
```

---

### Task 1: Clip names, triggers and times

**Files:**
- Create: `server/recordings/clipNames.ts`
- Test: `test/clipNames.test.ts`

**Interfaces:**
- Produces:
  - `Trigger = 'person' | 'vehicle' | 'pet' | 'motion' | 'timer'`
  - `ParsedClip = { name: string; stream: 'main' | 'sub'; date: string; start: string; end: string; dst: boolean; triggers: Trigger[] }`
    - `name` is the full camera name as returned by Search
    - `date` is camera-local `YYYY-MM-DD`
    - `start` and `end` are `HHMMSS`
  - `parseClipName(fullName: string): ParsedClip | null`
  - `decodeTriggers(flagsHex: string): Trigger[]`
  - `clipIdOf(p: ParsedClip): string`, `CLIP_ID: RegExp`, `DATE: RegExp`
  - `TimeInfo = { stdOffsetMinutes: number; dstOffsetMinutes: number }` and `timeInfoFromGetTime(value: unknown): TimeInfo`
  - `clipTimes(p: ParsedClip, t: TimeInfo): { start: string; end: string; durationSec: number }` (ISO with offset)

- [ ] **Step 1: Failing test `test/clipNames.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { clipIdOf, clipTimes, CLIP_ID, decodeTriggers, parseClipName, timeInfoFromGetTime } from '../server/recordings/clipNames';

const SUB = '/mnt/sda/Mp4Record/2026-09-25/RecS0A_DST20260925_125653_125718_0_55148080000000_927C9.mp4';
const MAIN = '/mnt/sda/Mp4Record/2026-09-25/RecM0A_DST20260925_121100_121119_0_7B288280000000_10BF000.mp4';
const CHICAGO = timeInfoFromGetTime({
  Time: { timeZone: 21600, isDst: 1 },
  Dst: { enable: 1, offset: 1 },
});

describe('decodeTriggers (name version 10, 14 hex digits)', () => {
  it.each([
    ['55148080000000', ['motion']],
    ['7B288280000000', ['motion']],
    ['5514C000000000', ['person']],
    ['55149000000000', ['vehicle']],
    ['55148800000000', ['pet']],
  ])('%s -> %j', (hex, triggers) => {
    expect(decodeTriggers(hex)).toEqual(triggers);
  });

  it('decodes several triggers at once, in a stable order', () => {
    // person + vehicle + motion
    expect(decodeTriggers('5514D080000000')).toEqual(['person', 'vehicle', 'motion']);
  });

  it('returns no triggers for flag fields of an unknown length', () => {
    expect(decodeTriggers('6D28808')).toEqual([]);
  });
});

describe('parseClipName', () => {
  it('parses a real sub-stream name', () => {
    expect(parseClipName(SUB)).toEqual({
      name: SUB,
      stream: 'sub',
      date: '2026-09-25',
      start: '125653',
      end: '125718',
      dst: true,
      triggers: ['motion'],
    });
  });

  it('parses a real main-stream name', () => {
    expect(parseClipName(MAIN)).toMatchObject({ stream: 'main', start: '121100', end: '121119', triggers: ['motion'] });
  });

  it('parses a name without the DST flag and without the animal-type field', () => {
    const p = parseClipName('Mp4Record/2026-01-10/RecS0A_20260110_080000_080030_55148080000000_927C9.mp4');
    expect(p).toMatchObject({ date: '2026-01-10', dst: false, start: '080000', end: '080030' });
  });

  it.each(['', 'foo.mp4', '/etc/passwd', 'RecX0A_20260925_125653_125718_0_55148080000000_927C9.mp4', 'RecS0A_20260925_1256_125718_0_5514_9.mp4'])(
    'rejects %j',
    (name) => expect(parseClipName(name)).toBeNull(),
  );
});

describe('clip ids', () => {
  it('derive from camera-local date and times', () => {
    expect(clipIdOf(parseClipName(SUB)!)).toBe('20260925-125653-125718');
    expect(CLIP_ID.test('20260925-125653-125718')).toBe(true);
  });

  it.each(['../etc', '20260925-125653', '20260925-125653-125718/..', '2026-09-25-125653-125718', '20260925%2F125653-125718'])(
    'rejects %j',
    (id) => expect(CLIP_ID.test(id)).toBe(false),
  );
});

describe('clipTimes', () => {
  it('uses the DST flag from the name for the offset', () => {
    expect(clipTimes(parseClipName(SUB)!, CHICAGO)).toEqual({
      start: '2026-09-25T12:56:53-05:00',
      end: '2026-09-25T12:57:18-05:00',
      durationSec: 25,
    });
  });

  it('uses standard time when the name has no DST flag', () => {
    const p = parseClipName('Mp4Record/2026-01-10/RecS0A_20260110_080000_080030_55148080000000_927C9.mp4')!;
    expect(clipTimes(p, CHICAGO).start).toBe('2026-01-10T08:00:00-06:00');
  });

  // Review focus 3: a clip running across midnight.
  it('rolls the end over to the next day when it is earlier than the start', () => {
    const p = parseClipName('Mp4Record/2026-09-25/RecS0A_DST20260925_235950_000020_0_55148080000000_927C9.mp4')!;
    expect(clipTimes(p, CHICAGO)).toEqual({
      start: '2026-09-25T23:59:50-05:00',
      end: '2026-09-26T00:00:20-05:00',
      durationSec: 30,
    });
  });

  it('reads GetTime into offsets', () => {
    expect(CHICAGO).toEqual({ stdOffsetMinutes: -360, dstOffsetMinutes: 60 });
    expect(timeInfoFromGetTime({ Time: { timeZone: -3600 }, Dst: { enable: 0, offset: 1 } })).toEqual({
      stdOffsetMinutes: 60,
      dstOffsetMinutes: 0,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/clipNames.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement `server/recordings/clipNames.ts`**

```ts
export type Trigger = 'person' | 'vehicle' | 'pet' | 'motion' | 'timer';

export interface ParsedClip {
  name: string;
  stream: 'main' | 'sub';
  date: string; // camera-local YYYY-MM-DD
  start: string; // HHMMSS
  end: string; // HHMMSS
  dst: boolean;
  triggers: Trigger[];
}

export interface TimeInfo {
  stdOffsetMinutes: number; // e.g. -360 for UTC-6
  dstOffsetMinutes: number; // added when a clip's name carries the DST flag
}

export const CLIP_ID = /^\d{8}-\d{6}-\d{6}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

// RecS0A_DST20260925_125653_125718_0_55148080000000_927C9.mp4
// stream, name version, optional DST, date, start, end, optional animal
// type, flags (hex), size (hex). Anything else is not a clip we know.
const NAME = /^Rec([MS])([0-9A-F]{2})_(DST)?(\d{8})_(\d{6})_(\d{6})_(?:\d+_)?([0-9A-F]+)_([0-9A-F]+)\.mp4$/i;

// Flag positions for name versions 9 and 10 (14 hex digits), counted in the
// bit-reversed number, as in the reolink_aio library. Verified against real
// clip names from our camera.
const REVERSED_POSITIONS: [Trigger, number][] = [
  ['person', 17],
  ['vehicle', 19],
  ['pet', 20],
  ['timer', 23],
  ['motion', 24],
];

export function decodeTriggers(flagsHex: string): Trigger[] {
  if (!/^[0-9A-F]{14}$/i.test(flagsHex)) return [];
  const value = BigInt(`0x${flagsHex}`);
  const bits = flagsHex.length * 4;
  return REVERSED_POSITIONS.filter(([, pos]) => ((value >> BigInt(bits - 1 - pos)) & 1n) === 1n).map(([t]) => t);
}

export function parseClipName(fullName: string): ParsedClip | null {
  const base = fullName.slice(fullName.lastIndexOf('/') + 1);
  const m = NAME.exec(base);
  if (!m) return null;
  const [, stream, , dst, ymd, start, end, flags] = m;
  return {
    name: fullName,
    stream: stream.toUpperCase() === 'M' ? 'main' : 'sub',
    date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
    start,
    end,
    dst: Boolean(dst),
    triggers: decodeTriggers(flags),
  };
}

export function clipIdOf(p: ParsedClip): string {
  return `${p.date.replaceAll('-', '')}-${p.start}-${p.end}`;
}

export function timeInfoFromGetTime(value: unknown): TimeInfo {
  const v = (value ?? {}) as { Time?: { timeZone?: number }; Dst?: { enable?: number; offset?: number } };
  const west = Number(v.Time?.timeZone ?? 0);
  const dstOn = Number(v.Dst?.enable ?? 0) === 1;
  return {
    stdOffsetMinutes: west === 0 ? 0 : -west / 60,
    dstOffsetMinutes: dstOn ? Number(v.Dst?.offset ?? 1) * 60 : 0,
  };
}

function offsetString(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function hms(s: string): string {
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

function seconds(s: string): number {
  return Number(s.slice(0, 2)) * 3600 + Number(s.slice(2, 4)) * 60 + Number(s.slice(4, 6));
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Camera-local wall times -> ISO with the exact offset. The DST flag in the
// name decides the offset, so the night the clocks change is still right.
export function clipTimes(p: ParsedClip, t: TimeInfo): { start: string; end: string; durationSec: number } {
  const off = offsetString(t.stdOffsetMinutes + (p.dst ? t.dstOffsetMinutes : 0));
  const startSec = seconds(p.start);
  let endSec = seconds(p.end);
  let endDate = p.date;
  if (endSec < startSec) {
    endDate = nextDay(p.date);
    endSec += 86400;
  }
  return {
    start: `${p.date}T${hms(p.start)}${off}`,
    end: `${endDate}T${hms(p.end)}${off}`,
    durationSec: endSec - startSec,
  };
}
```

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run 2>&1 | tail -4 && npm run build`. All tests should be green.
```bash
git add server/recordings/clipNames.ts test/clipNames.test.ts
git commit -m "feat: parse Reolink clip names, decode triggers, exact clip times"
```

---

### Task 2: Mock camera recordings and client search/download

**Files:**
- Create: `scripts/gen-mock-clips.sh`
- Generate and commit: `test/mock-camera/fixtures/clip-sub.mp4`, `test/mock-camera/fixtures/clip-main.mp4`
- Modify: `test/mock-camera/server.ts`, `server/reolink/client.ts`
- Test: `test/mockCamera.test.ts` (extend), `test/reolinkClient.test.ts` (extend)

**Interfaces:**
- Consumes `parseClipName` and `timeInfoFromGetTime` (Task 1); the mock, `ReolinkClient`, `getWithToken` and `isAuthRejection` (Plan 2).
- Produces:
  - `MockCameraOptions.clips?: MockClip[]`, where `MockClip = { daysAgo: number; start: string; end: string; triggers: ('person'|'vehicle'|'pet'|'motion')[] }`. The default list is `DEFAULT_MOCK_CLIPS`.
  - The mock implements `GetTime`, `Search` (day and month) and `Download` (bad token → 401 `text/html`, empty). It gives times in camera-local America/Chicago, with the DST flag from the real zone.
  - `MockState.downloads: number` and `MockState.activeDownloads: number`.
  - `ReolinkClient` gains:
    - `timeInfo(): Promise<TimeInfo>`, cached for 1 h
    - `searchDay(date: string, stream: 'main' | 'sub'): Promise<SearchFile[]>`, where `SearchFile = { name: string; size: number }`
    - `searchMonth(month: string): Promise<string[]>` (YYYY-MM → days)
    - `download(name: string, signal?: AbortSignal): Promise<IncomingMessage>`
  - `isAuthRejection` treats **401** like 403.

- [ ] **Step 1: Generate the clip fixtures**

`scripts/gen-mock-clips.sh`:
```bash
#!/usr/bin/env bash
# Synthetic recording clips for the mock camera: fragmented MP4 like the
# camera's Download returns (seekable in a browser). Committed; CI never runs this.
set -euo pipefail
dir=test/mock-camera/fixtures
for spec in "sub 320x180" "main 640x360"; do
  set -- $spec
  ffmpeg -v error -y -f lavfi -i "testsrc=size=$2:rate=10" -f lavfi -i sine=frequency=660:sample_rate=16000 \
    -t 12 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 10 -c:a aac -b:a 32k \
    -movflags frag_keyframe+empty_moov+default_base_moof "$dir/clip-$1.mp4"
done
ls -l "$dir"/clip-*.mp4
```
Run: `bash scripts/gen-mock-clips.sh`
Expected: `clip-sub.mp4` of about 100–250 KB and `clip-main.mp4` of about 200–500 KB.

- [ ] **Step 2: Failing mock tests (append to `test/mockCamera.test.ts`)**

```ts
describe('mock camera recordings', () => {
  async function token(app: Parameters<typeof request>[0]) {
    return (await login(app)).body[0].value.Token.name as string;
  }
  const search = (app: Parameters<typeof request>[0], t: string, onlyStatus: 0 | 1, day: Date, stream = 'sub') =>
    request(app)
      .post(`/cgi-bin/api.cgi?cmd=Search&token=${t}`)
      .send([
        {
          cmd: 'Search',
          action: 0,
          param: {
            Search: {
              channel: 0,
              onlyStatus,
              streamType: stream,
              StartTime: { year: day.getFullYear(), mon: day.getMonth() + 1, day: onlyStatus ? 1 : day.getDate(), hour: 0, min: 0, sec: 0 },
              EndTime: { year: day.getFullYear(), mon: day.getMonth() + 1, day: day.getDate(), hour: 23, min: 59, sec: 59 },
            },
          },
        },
      ]);

  it('answers GetTime like the real camera (UTC-6 with DST)', async () => {
    const { app } = createMockCamera(creds);
    const t = await token(app);
    const res = await request(app).post(`/cgi-bin/api.cgi?cmd=GetTime&token=${t}`).send([{ cmd: 'GetTime', action: 0, param: {} }]);
    expect(res.body[0].value.Time.timeZone).toBe(21600);
    expect(res.body[0].value.Dst).toMatchObject({ enable: 1, offset: 1 });
  });

  it('lists clips for a day with real-format names on both streams', async () => {
    const { app } = createMockCamera({ ...creds, clips: [{ daysAgo: 0, start: '081510', end: '081535', triggers: ['person'] }] });
    const t = await token(app);
    const today = chicagoToday();
    const sub = await search(app, t, 0, today, 'sub');
    const main = await search(app, t, 0, today, 'main');
    const subName: string = sub.body[0].value.SearchResult.File[0].name;
    expect(subName).toMatch(/\/Mp4Record\/\d{4}-\d{2}-\d{2}\/RecS0A_(DST)?\d{8}_081510_081535_0_5514C000000000_[0-9A-F]+\.mp4$/);
    expect(main.body[0].value.SearchResult.File[0].name).toMatch(/RecM0A_/);
  });

  it('marks days that have clips in the month table', async () => {
    const { app } = createMockCamera({ ...creds, clips: [{ daysAgo: 0, start: '081510', end: '081535', triggers: ['motion'] }] });
    const t = await token(app);
    const today = chicagoToday();
    const res = await search(app, t, 1, today);
    const table: string = res.body[0].value.SearchResult.Status[0].table;
    expect(table[today.getDate() - 1]).toBe('1');
  });

  it('downloads a clip with a valid token, and answers a bad token with 401 text/html like the firmware', async () => {
    const { app, state } = createMockCamera({ ...creds, clips: [{ daysAgo: 0, start: '081510', end: '081535', triggers: ['motion'] }] });
    const t = await token(app);
    const name = (await search(app, t, 0, chicagoToday())).body[0].value.SearchResult.File[0].name;
    const ok = await request(app).get(`/cgi-bin/api.cgi?cmd=Download&source=${encodeURIComponent(name)}&output=x.mp4&token=${t}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('video/mp4');
    expect(state.downloads).toBe(1);
    const bad = await request(app).get(`/cgi-bin/api.cgi?cmd=Download&source=${encodeURIComponent(name)}&output=x.mp4&token=nope`);
    expect(bad.status).toBe(401);
    expect(bad.headers['content-type']).toMatch(/^text\/html/);
    expect(bad.text).toBe('');
  });
});

// Calendar "today" in the mock camera's zone, as a local-date Date object.
function chicagoToday(): Date {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()).split('-').map(Number);
  return new Date(y, m - 1, d);
}
```

- [ ] **Step 3: Implement the mock additions in `test/mock-camera/server.ts`**

1. Add to `MockCameraOptions`: `clips?: MockClip[];`. Export:
```ts
export interface MockClip {
  daysAgo: number;
  start: string; // HHMMSS camera-local
  end: string;
  triggers: ('person' | 'vehicle' | 'pet' | 'motion')[];
}

// Four clips today, two yesterday: one per trigger, so filters and the
// timeline have something to show. Times are camera-local (America/Chicago).
export const DEFAULT_MOCK_CLIPS: MockClip[] = [
  { daysAgo: 0, start: '081510', end: '081535', triggers: ['person'] },
  { daysAgo: 0, start: '093000', end: '093020', triggers: ['vehicle'] },
  { daysAgo: 0, start: '120505', end: '120530', triggers: ['motion'] },
  { daysAgo: 0, start: '174540', end: '174605', triggers: ['pet'] },
  { daysAgo: 1, start: '070000', end: '070030', triggers: ['motion'] },
  { daysAgo: 1, start: '221510', end: '221540', triggers: ['person'] },
];
```
2. Add `downloads: 0` and `activeDownloads: 0` to `MockState` and to its initial value. Expose `downloads` and `activeDownloads` in `/__state` as well.
3. Helpers (module scope):
```ts
const TZ = 'America/Chicago';
const TRIGGER_POS: Record<string, number> = { person: 17, vehicle: 19, pet: 20, motion: 24 };
// Base flags of a real sub/main clip without trigger bits; see clipNames.ts.
const BASE_FLAGS = { sub: 0x55148000000000n, main: 0x7b288200000000n };

function flagsHex(stream: 'sub' | 'main', triggers: string[]): string {
  let v = BASE_FLAGS[stream];
  for (const t of triggers) v |= 1n << BigInt(55 - TRIGGER_POS[t]);
  return v.toString(16).toUpperCase().padStart(14, '0');
}

function chicagoParts(d: Date): { date: string; dst: boolean } {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' }).format(d);
  return { date, dst: /CDT/.test(name) };
}

function clipNames(clip: MockClip, stream: 'sub' | 'main'): { name: string; size: number; date: string } {
  const { date, dst } = chicagoParts(new Date(Date.now() - clip.daysAgo * 86400_000));
  const ymd = date.replaceAll('-', '');
  const size = stream === 'sub' ? 0x927c9 : 0x4eb60d;
  const base = `Rec${stream === 'sub' ? 'S' : 'M'}0A_${dst ? 'DST' : ''}${ymd}_${clip.start}_${clip.end}_0_${flagsHex(stream, clip.triggers)}_${size.toString(16).toUpperCase()}.mp4`;
  return { name: `/mnt/sda/Mp4Record/${date}/${base}`, size, date };
}
```
4. In the POST handler, after the `GetDevInfo` branch:
```ts
    if (cmd === 'GetTime') {
      res.json([{ cmd, code: 0, value: { Time: { timeZone: 21600, isDst: chicagoParts(new Date()).dst ? 1 : 0 }, Dst: { enable: 1, offset: 1 } } }]);
      return;
    }
    if (cmd === 'Search') {
      const s = param?.Search ?? {};
      const stream: 'sub' | 'main' = s.streamType === 'main' ? 'main' : 'sub';
      const clips = opts.clips ?? DEFAULT_MOCK_CLIPS;
      const startDate = `${s.StartTime.year}-${String(s.StartTime.mon).padStart(2, '0')}-${String(s.StartTime.day).padStart(2, '0')}`;
      const endDate = `${s.EndTime.year}-${String(s.EndTime.mon).padStart(2, '0')}-${String(s.EndTime.day).padStart(2, '0')}`;
      const named = clips.map((c) => clipNames(c, stream)).filter((c) => c.date >= startDate && c.date <= endDate);
      if (s.onlyStatus === 1) {
        const table = Array.from({ length: 31 }, (_, i) =>
          named.some((c) => Number(c.date.slice(8, 10)) === i + 1 && Number(c.date.slice(5, 7)) === s.StartTime.mon) ? '1' : '0',
        ).join('');
        res.json([{ cmd, code: 0, value: { SearchResult: { channel: 0, Status: [{ year: s.StartTime.year, mon: s.StartTime.mon, table }] } } }]);
        return;
      }
      const File = named.map((c) => ({ name: c.name, size: String(c.size), type: stream, frameRate: 0, width: 0, height: 0 }));
      res.json([{ cmd, code: 0, value: { SearchResult: { channel: 0, ...(File.length ? { File } : {}) } } }]);
      return;
    }
```
5. In the GET `/cgi-bin/api.cgi` handler, handle `Download` before the Snap logic:
```ts
    if (req.query.cmd === 'Download') {
      if (!valid(req)) {
        // Firmware: HTTP 401, text/html, empty body.
        res.status(401).type('text/html').end();
        return;
      }
      const source = String(req.query.source ?? '');
      const stream = /\/RecM/.test(source) ? 'main' : 'sub';
      state.downloads++;
      state.activeDownloads++;
      res.on('close', () => {
        state.activeDownloads--;
      });
      res.type('video/mp4').sendFile(join(FIXTURES, `clip-${stream}.mp4`));
      return;
    }
```

- [ ] **Step 4: Failing client tests (append to `test/reolinkClient.test.ts`)**

```ts
describe('ReolinkClient recordings', () => {
  it('reads camera time into offsets and caches it', async () => {
    const client = new ReolinkClient(cam);
    const t = await client.timeInfo();
    expect(t).toEqual({ stdOffsetMinutes: -360, dstOffsetMinutes: 60 });
    await client.timeInfo();
    // one GetTime only: cached
  });

  it('lists a day of clips with numeric sizes', async () => {
    const client = new ReolinkClient(cam);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    const files = await client.searchDay(today, 'sub');
    expect(files.length).toBeGreaterThan(0);
    expect(typeof files[0].size).toBe('number');
    expect(files[0].name).toMatch(/RecS0A_/);
  });

  it('returns [] for a day without clips', async () => {
    const client = new ReolinkClient(cam);
    expect(await client.searchDay('2001-01-01', 'sub')).toEqual([]);
  });

  it('lists days of a month that have recordings', async () => {
    const client = new ReolinkClient(cam);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    expect(await client.searchMonth(today.slice(0, 7))).toContain(today);
  });

  // Firmware: Download with a bad token answers 401 text/html (empty).
  it('re-logs in once when a download is rejected with 401', async () => {
    const client = new ReolinkClient(cam);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    const [file] = await client.searchDay(today, 'sub');
    state.revokeTokens();
    const before = state.loginAttempts;
    const res = await client.download(file.name);
    expect(res.headers['content-type']).toBe('video/mp4');
    res.resume();
    expect(state.loginAttempts - before).toBe(1);
  });
});
```
(`cam`, `state` and the per-test mock server come from the existing `beforeEach`. Use `createMockCamera` defaults, which include `DEFAULT_MOCK_CLIPS`.)

- [ ] **Step 5: Implement in `server/reolink/client.ts`**

1. In `isAuthRejection`, treat 401 like 403:
```ts
    if (res.statusCode === 401 || res.statusCode === 403) {
      res.resume();
      return true;
    }
```
Update the comment above it: Download answers a bad token with 401 `text/html`.

2. Add the imports `import { TimeInfo, timeInfoFromGetTime } from '../recordings/clipNames';` and the fields:
```ts
  private time: { value: TimeInfo; at: number } | null = null;
```
3. Add the methods:
```ts
  async timeInfo(): Promise<TimeInfo> {
    if (this.time && this.now() - this.time.at < 3600_000) return this.time.value;
    const value = timeInfoFromGetTime(await this.command<unknown>('GetTime'));
    this.time = { value, at: this.now() };
    return value;
  }

  private static dayRange(date: string) {
    const [year, mon, day] = date.split('-').map(Number);
    return {
      StartTime: { year, mon, day, hour: 0, min: 0, sec: 0 },
      EndTime: { year, mon, day, hour: 23, min: 59, sec: 59 },
    };
  }

  async searchDay(date: string, stream: 'main' | 'sub'): Promise<{ name: string; size: number }[]> {
    const value = await this.command<{ SearchResult?: { File?: { name: string; size: string | number }[] } }>('Search', {
      Search: { channel: 0, onlyStatus: 0, streamType: stream, ...ReolinkClient.dayRange(date) },
    });
    return (value.SearchResult?.File ?? []).map((f) => ({ name: f.name, size: Number(f.size) }));
  }

  // Days of a month (YYYY-MM) with recordings, from the camera's per-day table.
  async searchMonth(month: string): Promise<string[]> {
    const [year, mon] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    const value = await this.command<{ SearchResult?: { Status?: { year: number; mon: number; table: string }[] } }>('Search', {
      Search: {
        channel: 0,
        onlyStatus: 1,
        streamType: 'main',
        StartTime: { year, mon, day: 1, hour: 0, min: 0, sec: 0 },
        EndTime: { year, mon, day: lastDay, hour: 23, min: 59, sec: 59 },
      },
    });
    const days: string[] = [];
    for (const s of value.SearchResult?.Status ?? []) {
      if (s.year !== year || s.mon !== mon) continue;
      [...s.table].forEach((c, i) => {
        if (c === '1' && i < lastDay) days.push(`${month}-${String(i + 1).padStart(2, '0')}`);
      });
    }
    return days;
  }

  // A recording file as an HTTP stream. Not gated here: the recordings
  // service holds its own per-camera transfer slot for the whole transfer.
  async download(name: string, signal?: AbortSignal): Promise<IncomingMessage> {
    const base = name.slice(name.lastIndexOf('/') + 1);
    return this.getWithToken(
      (t) => `/cgi-bin/api.cgi?cmd=Download&source=${encodeURIComponent(name)}&output=${encodeURIComponent(base)}&token=${t}`,
      /^video\/mp4/,
      signal,
    );
  }
```

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run 2>&1 | tail -4`. All tests must be green. Run `test/reolinkClient.test.ts` and `test/mockCamera.test.ts` twice each, then `npm run build`.
```bash
git add scripts/gen-mock-clips.sh test/mock-camera test/mockCamera.test.ts test/reolinkClient.test.ts server/reolink/client.ts
git commit -m "feat: camera search, time and download; mock recordings matching the firmware"
```

---

### Task 3: Recordings service and API routes

**Files:**
- Create: `server/recordings/cache.ts`, `server/recordings/service.ts`, `server/recordings/thumbnail.ts`, `server/routes/recordings.ts`
- Modify: `server/routes/api.ts`, `test/setup.ts`
- Test: `test/recordingsCache.test.ts`, `test/recordingsRoutes.test.ts`

**Interfaces:**
- Consumes `getClient` (Plan 2); `parseClipName`, `clipIdOf`, `clipTimes`, `CLIP_ID`, `DATE` and `Trigger` (Task 1); `ReolinkClient.searchDay/searchMonth/timeInfo/download` (Task 2); `Semaphore` (Plan 2).
- Produces:
  - `DiskCache`:
    - constructor `(dir: string, maxBytes: number)`
    - `path(key: string): string`
    - `has(key): Promise<boolean>`
    - `touch(key): Promise<void>`
    - `fill(key, producer: (tmpPath: string) => Promise<void>): Promise<string>` (single-flight per key, temp file then rename, evicts to stay under the cap)
    - `pin(key)` / `unpin(key)`: pinned files are never evicted
  - `EventClip` (see the Global Constraints).
  - `RecordingsService`:
    - `days(cameraId, month)`
    - `events(cameraId, date)`
    - `clipFile(cameraId, clipId)` (the path to the cached sub clip)
    - `thumbnail(cameraId, clipId)`
    - `openDownload(cameraId, clipId, quality)` → `{ stream: IncomingMessage; filename: string; size: number | null }`
    - `class RecordingError extends Error { code: 'unknown_clip' | 'thumbnail_unavailable' }`
  - `getRecordings(): RecordingsService` (process-wide) and `resetRecordings(): void` (tests).
  - `makeThumbnail(input: string, output: string): Promise<void>`.
  - The routes listed in the Global Constraints.

- [ ] **Step 1: Failing cache test `test/recordingsCache.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DiskCache } from '../server/recordings/cache';

const dir = () => mkdtempSync(join(tmpdir(), 'cams-cache-'));
const bytes = (n: number) => async (tmp: string) => writeFileSync(tmp, Buffer.alloc(n, 1));

describe('DiskCache', () => {
  it('fills once and serves from disk afterwards', async () => {
    const cache = new DiskCache(dir(), 10_000);
    let calls = 0;
    const p = await cache.fill('a.mp4', async (tmp) => { calls++; writeFileSync(tmp, 'x'); });
    await cache.fill('a.mp4', async () => { calls++; });
    expect(calls).toBe(1);
    expect(statSync(p).size).toBe(1);
  });

  // Review focus 2: concurrent requests share one fetch.
  it('shares one producer between concurrent fills of the same key', async () => {
    const cache = new DiskCache(dir(), 10_000);
    let calls = 0;
    const producer = async (tmp: string) => { calls++; await new Promise((r) => setTimeout(r, 30)); writeFileSync(tmp, 'x'); };
    await Promise.all([cache.fill('k', producer), cache.fill('k', producer), cache.fill('k', producer)]);
    expect(calls).toBe(1);
  });

  // Review focus 2: a failed fetch leaves nothing behind.
  it('leaves no file (and no temp file) when the producer fails', async () => {
    const d = dir();
    const cache = new DiskCache(d, 10_000);
    await expect(cache.fill('bad', async (tmp) => { writeFileSync(tmp, 'partial'); throw new Error('camera gone'); })).rejects.toThrow('camera gone');
    expect(await cache.has('bad')).toBe(false);
    expect(readdirSync(d)).toEqual([]);
    // a later fill retries
    await cache.fill('bad', bytes(3));
    expect(await cache.has('bad')).toBe(true);
  });

  // Review focus 4: stays under the cap, oldest first, never a pinned file.
  it('evicts least recently used files to stay under the cap, skipping pinned ones', async () => {
    const d = dir();
    const cache = new DiskCache(d, 250);
    await cache.fill('old', bytes(100));
    await new Promise((r) => setTimeout(r, 15));
    await cache.fill('pinned', bytes(100));
    cache.pin('pinned');
    await new Promise((r) => setTimeout(r, 15));
    await cache.fill('new', bytes(100));
    expect(await cache.has('old')).toBe(false);
    expect(await cache.has('pinned')).toBe(true);
    expect(await cache.has('new')).toBe(true);
    cache.unpin('pinned');
  });

  it('rejects keys that could escape the cache directory', () => {
    const cache = new DiskCache(dir(), 100);
    for (const key of ['../x', 'a/b', '', '.hidden']) expect(() => cache.path(key)).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/recordingsCache.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement `server/recordings/cache.ts`**

```ts
import { promises as fs } from 'fs';
import { join } from 'path';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A flat directory of rebuildable files (clips, thumbnails) with a byte cap.
// Files are produced into a temp name and renamed, so readers never see a
// partial file; concurrent fills of one key share a single producer; the
// least recently used unpinned files go first when over the cap.
export class DiskCache {
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly pins = new Map<string, number>();
  private ready: Promise<void> | null = null;

  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {}

  path(key: string): string {
    if (!KEY.test(key) || key.includes('..')) throw new Error(`invalid cache key: ${key}`);
    return join(this.dir, key);
  }

  private ensureDir(): Promise<void> {
    this.ready ??= fs.mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  async has(key: string): Promise<boolean> {
    try {
      await fs.access(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async touch(key: string): Promise<void> {
    const now = new Date();
    await fs.utimes(this.path(key), now, now).catch(() => {});
  }

  pin(key: string): void {
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
  }

  unpin(key: string): void {
    const n = (this.pins.get(key) ?? 1) - 1;
    if (n <= 0) this.pins.delete(key);
    else this.pins.set(key, n);
  }

  fill(key: string, producer: (tmpPath: string) => Promise<void>): Promise<string> {
    const target = this.path(key);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const work = (async () => {
      await this.ensureDir();
      if (await this.has(key)) {
        await this.touch(key);
        return target;
      }
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      try {
        await producer(tmp);
        await fs.rename(tmp, target);
      } catch (err) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      await this.evict(key);
      return target;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async evict(justAdded: string): Promise<void> {
    const names = (await fs.readdir(this.dir)).filter((n) => !n.includes('.tmp-'));
    const files = await Promise.all(
      names.map(async (name) => {
        const s = await fs.stat(join(this.dir, name)).catch(() => null);
        return s ? { name, size: s.size, mtime: s.mtimeMs } : null;
      }),
    );
    const live = files.filter((f): f is { name: string; size: number; mtime: number } => f !== null);
    let total = live.reduce((sum, f) => sum + f.size, 0);
    for (const f of live.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= this.maxBytes) break;
      if (f.name === justAdded || this.pins.has(f.name)) continue;
      await fs.rm(join(this.dir, f.name), { force: true });
      total -= f.size;
    }
  }
}
```

- [ ] **Step 4: Implement `server/recordings/thumbnail.ts`**

```ts
import { spawn } from 'child_process';

// One frame, one second in, scaled to 320 px wide. ffmpeg's stderr is
// discarded (it can echo file paths); only the exit status matters.
export function makeThumbnail(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      process.env.FFMPEG_PATH || 'ffmpeg',
      ['-v', 'error', '-y', '-ss', '1', '-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', '-f', 'mjpeg', output],
      { stdio: 'ignore' },
    );
    const timer = setTimeout(() => ff.kill('SIGKILL'), 15_000);
    ff.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ff.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}`));
    });
  });
}
```

- [ ] **Step 5: Implement `server/recordings/service.ts`**

```ts
import { createWriteStream } from 'fs';
import { IncomingMessage } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { getClient } from '../reolink/clients';
import { Semaphore } from '../reolink/semaphore';
import { clipIdOf, clipTimes, CLIP_ID, parseClipName, ParsedClip, Trigger } from './clipNames';
import { DiskCache } from './cache';
import { makeThumbnail } from './thumbnail';

export interface EventClip {
  id: string;
  start: string;
  end: string;
  durationSec: number;
  triggers: Trigger[];
  sizeSub: number | null;
  sizeMain: number | null;
}

export class RecordingError extends Error {
  constructor(readonly code: 'unknown_clip' | 'thumbnail_unavailable', message: string) {
    super(message);
    this.name = 'RecordingError';
  }
}

interface DayEntry {
  at: number;
  events: EventClip[];
  names: Map<string, { sub?: string; main?: string }>;
}

const TODAY_TTL = 30_000;
const PAST_TTL = 600_000;
const MONTH_TTL = 300_000;
const TRANSFERS_PER_CAMERA = 2;

function cameraToday(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export class RecordingsService {
  private readonly days_ = new Map<string, { at: number; days: string[] }>();
  private readonly daysInflight = new Map<string, Promise<DayEntry>>();
  private readonly dayCache = new Map<string, DayEntry>();
  private readonly transfers = new Map<string, Semaphore>();

  constructor(private readonly cache: DiskCache) {}

  private client(cameraId: string) {
    const c = getClient(cameraId);
    if (!c) throw new RecordingError('unknown_clip', 'unknown camera');
    return c;
  }

  private gate(cameraId: string): Semaphore {
    let g = this.transfers.get(cameraId);
    if (!g) this.transfers.set(cameraId, (g = new Semaphore(TRANSFERS_PER_CAMERA)));
    return g;
  }

  async days(cameraId: string, month: string): Promise<string[]> {
    const key = `${cameraId}|${month}`;
    const hit = this.days_.get(key);
    if (hit && Date.now() - hit.at < MONTH_TTL) return hit.days;
    const days = await this.client(cameraId).searchMonth(month);
    this.days_.set(key, { at: Date.now(), days });
    return days;
  }

  private async day(cameraId: string, date: string): Promise<DayEntry> {
    const key = `${cameraId}|${date}`;
    const client = this.client(cameraId);
    const time = await client.timeInfo();
    const ttl = date === cameraToday(time.stdOffsetMinutes + time.dstOffsetMinutes) ? TODAY_TTL : PAST_TTL;
    const hit = this.dayCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit;
    const inflight = this.daysInflight.get(key);
    if (inflight) return inflight;
    const work = (async () => {
      const [sub, main] = await Promise.all([client.searchDay(date, 'sub'), client.searchDay(date, 'main')]);
      const byId = new Map<string, { parsed: ParsedClip; sub?: { name: string; size: number }; main?: { name: string; size: number } }>();
      for (const [stream, files] of [['sub', sub], ['main', main]] as const) {
        for (const f of files) {
          const parsed = parseClipName(f.name);
          if (!parsed || parsed.date !== date) continue;
          const id = clipIdOf(parsed);
          const entry = byId.get(id) ?? { parsed };
          entry[stream] = f;
          // The main stream's flags are authoritative for triggers when both exist.
          if (stream === 'main') entry.parsed = { ...parsed, triggers: parsed.triggers.length ? parsed.triggers : entry.parsed.triggers };
          byId.set(id, entry);
        }
      }
      const events: EventClip[] = [...byId.entries()]
        .map(([id, e]) => ({
          id,
          ...clipTimes(e.parsed, time),
          triggers: e.parsed.triggers,
          sizeSub: e.sub?.size ?? null,
          sizeMain: e.main?.size ?? null,
        }))
        .sort((a, b) => (a.start < b.start ? -1 : 1));
      const names = new Map([...byId.entries()].map(([id, e]) => [id, { sub: e.sub?.name, main: e.main?.name }]));
      const entry = { at: Date.now(), events, names };
      this.dayCache.set(key, entry);
      return entry;
    })().finally(() => this.daysInflight.delete(key));
    this.daysInflight.set(key, work);
    return work;
  }

  async events(cameraId: string, date: string): Promise<EventClip[]> {
    return (await this.day(cameraId, date)).events;
  }

  // Review focus 1: ids are validated and resolved only through this
  // camera's own Search results; a camera path never comes from the client.
  private async names(cameraId: string, clipId: string): Promise<{ sub?: string; main?: string }> {
    if (!CLIP_ID.test(clipId)) throw new RecordingError('unknown_clip', 'malformed clip id');
    const date = `${clipId.slice(0, 4)}-${clipId.slice(4, 6)}-${clipId.slice(6, 8)}`;
    const names = (await this.day(cameraId, date)).names.get(clipId);
    if (!names) throw new RecordingError('unknown_clip', 'no such clip');
    return names;
  }

  private key(cameraId: string, clipId: string, ext: string): string {
    return `${cameraId}_${clipId}.${ext}`;
  }

  async clipFile(cameraId: string, clipId: string): Promise<string> {
    const { sub } = await this.names(cameraId, clipId);
    if (!sub) throw new RecordingError('unknown_clip', 'clip has no sub stream');
    const key = this.key(cameraId, clipId, 'mp4');
    return this.cache.fill(key, (tmp) =>
      this.gate(cameraId).run(async () => {
        const res = await this.client(cameraId).download(sub);
        await pipeline(res, createWriteStream(tmp));
      }),
    );
  }

  async thumbnail(cameraId: string, clipId: string): Promise<string> {
    const video = await this.clipFile(cameraId, clipId);
    const videoKey = this.key(cameraId, clipId, 'mp4');
    this.cache.pin(videoKey);
    try {
      return await this.cache.fill(this.key(cameraId, clipId, 'jpg'), async (tmp) => {
        try {
          await makeThumbnail(video, tmp);
        } catch {
          throw new RecordingError('thumbnail_unavailable', 'thumbnail could not be made');
        }
      });
    } finally {
      this.cache.unpin(videoKey);
    }
  }

  pinned<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.cache.pin(key);
    return fn().finally(() => this.cache.unpin(key));
  }

  videoKey(cameraId: string, clipId: string): string {
    return this.key(cameraId, clipId, 'mp4');
  }

  // Full-quality downloads stream straight through (not cached). The caller
  // must call release() once the response has ended or closed.
  async openDownload(
    cameraId: string,
    clipId: string,
    quality: 'sub' | 'main',
  ): Promise<{ stream: IncomingMessage; filename: string; release: () => void }> {
    const names = await this.names(cameraId, clipId);
    const name = quality === 'main' ? (names.main ?? names.sub) : (names.sub ?? names.main);
    if (!name) throw new RecordingError('unknown_clip', 'clip has no file');
    const date = `${clipId.slice(0, 4)}-${clipId.slice(4, 6)}-${clipId.slice(6, 8)}`;
    const t = clipId.slice(9, 15);
    const filename = `${cameraId}-${date}_${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}-${quality}.mp4`;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    void this.gate(cameraId).run(async () => {
      acquired();
      await slot;
    });
    await got;
    try {
      const stream = await this.client(cameraId).download(name);
      return { stream, filename, release };
    } catch (err) {
      release();
      throw err;
    }
  }
}

let service: RecordingsService | null = null;

export function getRecordings(): RecordingsService {
  service ??= new RecordingsService(
    new DiskCache(process.env.CACHE_DIR || join(tmpdir(), 'cams-cache'), Number(process.env.CACHE_MAX_BYTES) || 1.5 * 1024 ** 3),
  );
  return service;
}

export function resetRecordings(): void {
  service = null;
}
```

- [ ] **Step 6: Routes `server/routes/recordings.ts`**

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { getCamera } from '../cameraRegistry';
import { CameraError } from '../reolink/client';
import { logger } from '../logger';
import { CLIP_ID, DATE } from '../recordings/clipNames';
import { getRecordings, RecordingError } from '../recordings/service';

export const recordingsRouter = Router();

function fail(err: unknown, cameraId: string, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof RecordingError) {
    res.status(err.code === 'unknown_clip' ? 404 : 503).json({ error: err.code });
    return;
  }
  if (err instanceof CameraError) {
    logger.warn({ cameraId, code: err.code, message: err.message }, 'camera_request_failed');
    res.status(err.code === 'camera_error' ? 502 : 503).json({ error: err.code });
    return;
  }
  next(err);
}

function camera(req: Request, res: Response): string | undefined {
  const id = String(req.params.id);
  if (!getCamera(id)) {
    res.status(404).json({ error: 'unknown_camera' });
    return undefined;
  }
  return id;
}

function clip(req: Request, res: Response): string | undefined {
  const id = String(req.params.clipId);
  if (!CLIP_ID.test(id)) {
    res.status(400).json({ error: 'bad_request' });
    return undefined;
  }
  return id;
}

recordingsRouter.get('/api/cameras/:id/days', async (req, res, next) => {
  const id = camera(req, res);
  if (!id) return;
  const month = String(req.query.month ?? '');
  if (!/^\d{4}-\d{2}$/.test(month)) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  try {
    res.json({ days: await getRecordings().days(id, month) });
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/events', async (req, res, next) => {
  const id = camera(req, res);
  if (!id) return;
  const date = String(req.query.date ?? '');
  if (!DATE.test(date)) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  try {
    res.json({ date, events: await getRecordings().events(id, date) });
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/clips/:clipId/video', async (req, res, next) => {
  const id = camera(req, res);
  const clipId = id && clip(req, res);
  if (!id || !clipId) return;
  const rec = getRecordings();
  try {
    const path = await rec.clipFile(id, clipId);
    const key = rec.videoKey(id, clipId);
    // Review focus 4: the file can't be evicted while it's being served.
    await rec.pinned(key, () => new Promise<void>((resolve) => {
      res.sendFile(path, { headers: { 'Content-Type': 'video/mp4' } }, () => resolve());
    }));
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/clips/:clipId/thumb.jpg', async (req, res, next) => {
  const id = camera(req, res);
  const clipId = id && clip(req, res);
  if (!id || !clipId) return;
  try {
    res.type('image/jpeg').sendFile(await getRecordings().thumbnail(id, clipId));
  } catch (err) {
    fail(err, id, res, next);
  }
});

recordingsRouter.get('/api/cameras/:id/clips/:clipId/download', async (req, res, next) => {
  const id = camera(req, res);
  const clipId = id && clip(req, res);
  if (!id || !clipId) return;
  const quality = req.query.quality === 'main' ? 'main' : 'sub';
  try {
    const { stream, filename, release } = await getRecordings().openDownload(id, clipId, quality);
    res.on('close', () => {
      stream.destroy();
      release();
    });
    res.status(200).set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    stream.pipe(res);
  } catch (err) {
    fail(err, id, res, next);
  }
});
```

In `server/routes/api.ts`, register `recordingsRouter` next to `camerasRouter`, before the `/api` 404:
```ts
import { recordingsRouter } from './recordings';
```
```ts
apiRouter.use(camerasRouter);
apiRouter.use(recordingsRouter);
```

Append to `test/setup.ts`:
```ts
import { resetRecordings } from '../server/recordings/service';

beforeEach(() => resetRecordings());
```
Also make the test environment point the cache at a temp dir. In `vitest.config.mts`, set `env.CACHE_DIR` to `'/tmp/cams-test-cache'` alongside `LOG_LEVEL`. Clear it in `test/setup.ts` with a `beforeAll(() => rmSync('/tmp/cams-test-cache', { recursive: true, force: true }))`.

- [ ] **Step 7: Failing route test `test/recordingsRoutes.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { resetRecordings } from '../server/recordings/service';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createMockCamera, MockState } from './mock-camera/server';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
let cam: Server;
let state: MockState;

beforeEach(async () => {
  const mock = createMockCamera({ user: 'u', password: 'p' });
  state = mock.state;
  cam = mock.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  setCameras([
    { id: 'cam1', name: 'Den', host: `127.0.0.1:${(cam.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p' },
    { id: 'cam2', name: 'Other', host: `127.0.0.1:${(cam.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p' },
  ]);
  resetClients();
  resetRecordings();
});
afterEach(async () => {
  await new Promise<void>((r) => cam.close(() => r()));
  setCameras([]);
});

async function firstClip(date = today()) {
  const res = await request(createApp()).get(`/api/cameras/cam1/events?date=${date}`).set('Cookie', auth);
  return res.body.events[0];
}

describe('recordings API', () => {
  it('lists today\'s events with exact times, triggers and sizes', async () => {
    const res = await request(createApp()).get(`/api/cameras/cam1/events?date=${today()}`).set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { triggers: string[] }) => e.triggers)).toEqual([['person'], ['vehicle'], ['motion'], ['pet']]);
    const e = res.body.events[0];
    expect(e.id).toMatch(/^\d{8}-081510-081535$/);
    expect(e.start).toMatch(new RegExp(`^${today()}T08:15:10-0[56]:00$`));
    expect(e.durationSec).toBe(25);
    expect(e.sizeSub).toBeGreaterThan(0);
    expect(e.sizeMain).toBeGreaterThan(0);
  });

  // Review focus 5: an empty day is an empty list, not an error.
  it('returns an empty list for a day without recordings', async () => {
    const res = await request(createApp()).get('/api/cameras/cam1/events?date=2001-01-01').set('Cookie', auth);
    expect(res.body).toEqual({ date: '2001-01-01', events: [] });
  });

  it('lists days with recordings in a month', async () => {
    const res = await request(createApp()).get(`/api/cameras/cam1/days?month=${today().slice(0, 7)}`).set('Cookie', auth);
    expect(res.body.days).toContain(today());
  });

  it('rejects malformed dates, months and clip ids with 400', async () => {
    const app = createApp();
    expect((await request(app).get('/api/cameras/cam1/events?date=2026-9-1').set('Cookie', auth)).status).toBe(400);
    expect((await request(app).get('/api/cameras/cam1/days?month=202609').set('Cookie', auth)).status).toBe(400);
    expect((await request(app).get('/api/cameras/cam1/clips/..%2F..%2Fetc/video').set('Cookie', auth)).status).toBe(400);
    expect((await request(app).get('/api/cameras/cam1/clips/not-a-clip/thumb.jpg').set('Cookie', auth)).status).toBe(400);
  });

  // Review focus 1: a well-formed id that this camera never listed is unknown.
  it('404s a well-formed clip id the camera never listed', async () => {
    const res = await request(createApp()).get('/api/cameras/cam1/clips/20010101-000000-000010/video').set('Cookie', auth);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unknown_clip' });
  });

  it('serves the clip as seekable MP4 with Range support, fetching it from the camera once', async () => {
    const e = await firstClip();
    const app = createApp();
    const full = await request(app).get(`/api/cameras/cam1/clips/${e.id}/video`).set('Cookie', auth);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await request(app).get(`/api/cameras/cam1/clips/${e.id}/video`).set('Cookie', auth).set('Range', 'bytes=0-99');
    expect(part.status).toBe(206);
    expect(part.headers['content-length']).toBe('100');
    expect(state.downloads).toBe(1);
  });

  // Review focus 2: concurrent first requests share one camera transfer.
  it('shares one camera download between concurrent first requests for a clip', async () => {
    const e = await firstClip();
    const app = createApp();
    await Promise.all([1, 2, 3].map(() => request(app).get(`/api/cameras/cam1/clips/${e.id}/video`).set('Cookie', auth)));
    expect(state.downloads).toBe(1);
  });

  it('makes a JPEG thumbnail', async () => {
    const e = await firstClip();
    const res = await request(createApp()).get(`/api/cameras/cam1/clips/${e.id}/thumb.jpg`).set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('streams a full-quality download as an attachment with a readable name', async () => {
    const e = await firstClip();
    const res = await request(createApp()).get(`/api/cameras/cam1/clips/${e.id}/download?quality=main`).set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="cam1-${today()}_08-15-10-main.mp4"`);
    expect(res.headers['content-type']).toBe('video/mp4');
  });

  it('never lets one camera\'s id reach another camera\'s cache entry', async () => {
    const e = await firstClip();
    const app = createApp();
    await request(app).get(`/api/cameras/cam1/clips/${e.id}/video`).set('Cookie', auth);
    // cam2 must fetch its own copy rather than reuse cam1's file.
    await request(app).get(`/api/cameras/cam2/clips/${e.id}/video`).set('Cookie', auth);
    expect(state.downloads).toBe(2);
  });

  it('requires a session', async () => {
    expect((await request(createApp()).get(`/api/cameras/cam1/events?date=${today()}`)).status).toBe(401);
  });
});
```

- [ ] **Step 8: Verify and commit**

Run `npx vitest run 2>&1 | tail -4` (it must be all green; `ffmpeg` must be on PATH) and `npm run build`. Run the two new files twice.
```bash
git add server/recordings server/routes/recordings.ts server/routes/api.ts test/recordingsCache.test.ts test/recordingsRoutes.test.ts test/setup.ts vitest.config.mts
git commit -m "feat: recordings API with clip cache, Range playback, thumbnails and downloads"
```

---

### Task 4: Image and CI get ffmpeg

**Files:**
- Modify: `Dockerfile`, `.github/workflows/production-checks.yml`, `.github/workflows/build-push.yml`

- [ ] **Step 1: `Dockerfile` runtime stage.** After `WORKDIR /app` in the second stage:
```dockerfile
# Thumbnails of recorded clips (server/recordings/thumbnail.ts).
RUN apk add --no-cache ffmpeg
```
Also add `ENV CACHE_DIR=/var/cache/cams` (the ksvc mounts an emptyDir there), and keep `USER 1000:1000` last. The emptyDir is writable by uid 1000 through the pod's `fsGroup`, or through an explicit volume mode that kube-setup sets; Task 8 asks kube-setup for it.

- [ ] **Step 2: CI.** Both `test` and `e2e` in `production-checks.yml`, and `build-push.yml`'s test step, need ffmpeg. Add this before the step that runs the tests:
```yaml
      - name: Ensure ffmpeg (thumbnail tests)
        run: command -v ffmpeg || (sudo apt-get update && sudo apt-get install -y --no-install-recommends ffmpeg)
```
In `production-checks.yml`, put it after the existing `sudo rm -f /etc/apt/sources.list.d/google-chrome.list` in the e2e job, and add the same `rm` line before it in the `test` job so `apt-get update` can't fail on the Chrome list.

- [ ] **Step 3: Verify.** Build the image:
```bash
docker build -t cams:p3 . && docker run --rm cams:p3 sh -c 'ffmpeg -version | head -1 && id'
```
Expected: an ffmpeg version line, then `uid=1000 gid=1000`. Validate the YAML with `python3 -c "import yaml,glob;[yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')];print('ok')"`.

- [ ] **Step 4: Commit**
```bash
git add Dockerfile .github/workflows
git commit -m "build: ffmpeg in the image and CI for clip thumbnails"
```

---

### Task 5: Recordings client library (pure, tested)

**Files:**
- Create: `web/src/lib/recordings.ts`, `web/src/lib/recordings.test.ts`

**Interfaces:**
- Produces:
  - Types: `Trigger`, `EventClip` (same shape as the server's), `Filter = 'all' | Trigger`, `Zoom = 24 | 6 | 1`, `Cursor = { date: string; clipId: string | null; offsetSec: number }`.
  - `TRIGGER_LABELS: Record<Trigger, string>` and `FILTERS: Filter[]`.
  - `localDate(d: Date): string`: YYYY-MM-DD in the browser's zone.
  - `addDays(date: string, n: number): string`.
  - `secondsIntoDay(iso: string, date: string): number`: the seconds of the clip start since local midnight of `date`, in the browser zone.
  - `timelineWindow(zoom: Zoom, centerSec: number): { start: number; end: number }`, clamped to [0, 86400].
  - `layoutSegments(events, date, win): { id: string; left: number; width: number; ai: boolean }[]`. Values are percentages, and the minimum width is 0.4 %.
  - `clipAtSecond(events, date, sec): EventClip | null`: the clip containing `sec`; otherwise the nearest start within 5 minutes; otherwise null.
  - `neighbour(events, id, dir: -1 | 1): EventClip | null`.
  - `filterEvents(events, filter): EventClip[]`.
  - `formatBytes(n: number | null): string`.
  - `formatClock(iso: string): string`: local HH:MM:SS.
  - URL builders: `eventsUrl(cam, date)`, `daysUrl(cam, month)`, `videoUrl(cam, id)`, `thumbUrl(cam, id)`, `downloadUrl(cam, id, quality)`.
  - Cursor URL helpers:
    - `parseCursor(params: URLSearchParams, today: string): { cam: string | null; cursor: Cursor; filter: Filter }`
    - `cursorSearch(cam: string, cursor: Cursor, panel: string, filter: Filter): string`, which returns a string starting with `?`
  - `CURSOR_KEY = 'cams-cursor'`, `saveCursor(cam, cursor)` and `loadCursor(): { cam: string; cursor: Cursor } | null`, both via sessionStorage with try/catch.

- [ ] **Step 1: Failing test `web/src/lib/recordings.test.ts`**

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays, clipAtSecond, cursorSearch, filterEvents, formatBytes, layoutSegments, loadCursor, neighbour,
  parseCursor, saveCursor, secondsIntoDay, timelineWindow, type EventClip,
} from './recordings';

// Tests run with TZ=America/Chicago (vitest.config.mts env); clip times use -05:00.
const E = (id: string, start: string, end: string, triggers: EventClip['triggers']): EventClip => ({
  id, start, end, durationSec: 25, triggers, sizeSub: 100, sizeMain: 1000,
});
const DAY = '2026-09-25';
const events = [
  E('20260925-081510-081535', `${DAY}T08:15:10-05:00`, `${DAY}T08:15:35-05:00`, ['person']),
  E('20260925-120505-120530', `${DAY}T12:05:05-05:00`, `${DAY}T12:05:30-05:00`, ['motion']),
  E('20260925-174540-174605', `${DAY}T17:45:40-05:00`, `${DAY}T17:46:05-05:00`, ['pet']),
];

afterEach(() => vi.unstubAllGlobals());

describe('time helpers', () => {
  it('computes seconds into the local day', () => {
    expect(secondsIntoDay(events[0].start, DAY)).toBe(8 * 3600 + 15 * 60 + 10);
  });
  it('adds days across month ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });
});

describe('timeline', () => {
  it('shows the whole day at 24 h and clamps narrower windows to the day', () => {
    expect(timelineWindow(24, 50_000)).toEqual({ start: 0, end: 86400 });
    expect(timelineWindow(1, 600)).toEqual({ start: 0, end: 3600 });
    expect(timelineWindow(1, 86000)).toEqual({ start: 82800, end: 86400 });
    expect(timelineWindow(6, 43200)).toEqual({ start: 32400, end: 54000 });
  });

  it('lays out segments inside the window with AI marked', () => {
    const segs = layoutSegments(events, DAY, { start: 0, end: 86400 });
    expect(segs).toHaveLength(3);
    expect(segs[0].ai).toBe(true);
    expect(segs[1].ai).toBe(false);
    expect(segs[0].left).toBeCloseTo(((8 * 3600 + 15 * 60 + 10) / 86400) * 100, 3);
    expect(segs[0].width).toBeGreaterThanOrEqual(0.4);
  });

  it('drops segments outside the window', () => {
    expect(layoutSegments(events, DAY, { start: 43200, end: 46800 }).map((s) => s.id)).toEqual(['20260925-120505-120530']);
  });

  it('finds the clip under a click, or the nearest start within 5 minutes', () => {
    expect(clipAtSecond(events, DAY, 12 * 3600 + 5 * 60 + 20)?.id).toBe('20260925-120505-120530');
    expect(clipAtSecond(events, DAY, 12 * 3600 + 2 * 60)?.id).toBe('20260925-120505-120530');
    expect(clipAtSecond(events, DAY, 3 * 3600)).toBeNull();
  });

  it('steps to neighbours', () => {
    expect(neighbour(events, events[1].id, 1)?.id).toBe(events[2].id);
    expect(neighbour(events, events[1].id, -1)?.id).toBe(events[0].id);
    expect(neighbour(events, events[2].id, 1)).toBeNull();
  });
});

describe('filters and formatting', () => {
  it('filters by trigger', () => {
    expect(filterEvents(events, 'person').map((e) => e.id)).toEqual([events[0].id]);
    expect(filterEvents(events, 'all')).toHaveLength(3);
  });
  it('formats sizes', () => {
    expect(formatBytes(600_009)).toBe('586 KB');
    expect(formatBytes(17_559_552)).toBe('16.7 MB');
    expect(formatBytes(null)).toBe('—');
  });
});

describe('cursor', () => {
  it('parses and serialises the URL cursor', () => {
    const q = cursorSearch('cam1', { date: DAY, clipId: events[0].id, offsetSec: 12.4 }, 'events', 'person');
    expect(q).toBe(`?cam=cam1&date=${DAY}&clip=${events[0].id}&t=12&panel=events&filter=person`);
    expect(parseCursor(new URLSearchParams(q), '2026-09-26')).toEqual({
      cam: 'cam1', cursor: { date: DAY, clipId: events[0].id, offsetSec: 12 }, filter: 'person',
    });
  });

  it('defaults to today and ignores malformed values', () => {
    expect(parseCursor(new URLSearchParams('?date=bad&clip=../x&t=-4&filter=zzz'), '2026-09-26')).toEqual({
      cam: null, cursor: { date: '2026-09-26', clipId: null, offsetSec: 0 }, filter: 'all',
    });
  });

  it('remembers the last cursor in sessionStorage and survives storage errors', () => {
    saveCursor('cam1', { date: DAY, clipId: events[0].id, offsetSec: 3 });
    expect(loadCursor()).toEqual({ cam: 'cam1', cursor: { date: DAY, clipId: events[0].id, offsetSec: 3 } });
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } });
    expect(() => saveCursor('cam1', { date: DAY, clipId: null, offsetSec: 0 })).not.toThrow();
    expect(loadCursor()).toBeNull();
  });
});
```
In `vitest.config.mts`, add `TZ: 'America/Chicago'` to `test.env` so browser-zone helpers are deterministic.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run web/src/lib/recordings.test.ts`. It fails because the module doesn't exist yet.

- [ ] **Step 3: Implement `web/src/lib/recordings.ts`**

```ts
export type Trigger = 'person' | 'vehicle' | 'pet' | 'motion' | 'timer';
export type Filter = 'all' | 'person' | 'vehicle' | 'pet' | 'motion';
export type Zoom = 24 | 6 | 1;

export interface EventClip {
  id: string;
  start: string;
  end: string;
  durationSec: number;
  triggers: Trigger[];
  sizeSub: number | null;
  sizeMain: number | null;
}

export interface Cursor {
  date: string;
  clipId: string | null;
  offsetSec: number;
}

export const TRIGGER_LABELS: Record<Trigger, string> = {
  person: 'Person',
  vehicle: 'Vehicle',
  pet: 'Pet',
  motion: 'Motion',
  timer: 'Scheduled',
};
export const FILTERS: Filter[] = ['all', 'person', 'vehicle', 'pet', 'motion'];
const AI: Trigger[] = ['person', 'vehicle', 'pet'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLIP = /^\d{8}-\d{6}-\d{6}$/;
export const CURSOR_KEY = 'cams-cursor';

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n));
}

export function secondsIntoDay(iso: string, date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(iso).getTime() - new Date(y, m - 1, d).getTime()) / 1000;
}

export function timelineWindow(zoom: Zoom, centerSec: number): { start: number; end: number } {
  if (zoom === 24) return { start: 0, end: 86400 };
  const span = zoom * 3600;
  const start = Math.min(Math.max(0, centerSec - span / 2), 86400 - span);
  return { start, end: start + span };
}

export function layoutSegments(
  events: EventClip[],
  date: string,
  win: { start: number; end: number },
): { id: string; left: number; width: number; ai: boolean }[] {
  const span = win.end - win.start;
  return events
    .map((e) => {
      const s = secondsIntoDay(e.start, date);
      return { e, s, t: s + e.durationSec };
    })
    .filter(({ s, t }) => t > win.start && s < win.end)
    .map(({ e, s, t }) => ({
      id: e.id,
      left: ((Math.max(s, win.start) - win.start) / span) * 100,
      width: Math.max(0.4, ((Math.min(t, win.end) - Math.max(s, win.start)) / span) * 100),
      ai: e.triggers.some((x) => AI.includes(x)),
    }));
}

export function clipAtSecond(events: EventClip[], date: string, sec: number): EventClip | null {
  let best: EventClip | null = null;
  let bestDist = 300;
  for (const e of events) {
    const s = secondsIntoDay(e.start, date);
    if (sec >= s && sec <= s + e.durationSec) return e;
    const dist = Math.abs(s - sec);
    if (dist <= bestDist) {
      best = e;
      bestDist = dist;
    }
  }
  return best;
}

export function neighbour(events: EventClip[], id: string, dir: -1 | 1): EventClip | null {
  const i = events.findIndex((e) => e.id === id);
  return i < 0 ? null : (events[i + dir] ?? null);
}

export function filterEvents(events: EventClip[], filter: Filter): EventClip[] {
  return filter === 'all' ? events : events.filter((e) => e.triggers.includes(filter));
}

export function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
}

const cam = (id: string) => encodeURIComponent(id);
export const eventsUrl = (c: string, date: string) => `/api/cameras/${cam(c)}/events?date=${date}`;
export const daysUrl = (c: string, month: string) => `/api/cameras/${cam(c)}/days?month=${month}`;
export const videoUrl = (c: string, id: string) => `/api/cameras/${cam(c)}/clips/${id}/video`;
export const thumbUrl = (c: string, id: string) => `/api/cameras/${cam(c)}/clips/${id}/thumb.jpg`;
export const downloadUrl = (c: string, id: string, q: 'sub' | 'main') => `/api/cameras/${cam(c)}/clips/${id}/download?quality=${q}`;

export function parseCursor(params: URLSearchParams, today: string): { cam: string | null; cursor: Cursor; filter: Filter } {
  const date = params.get('date') ?? '';
  const clip = params.get('clip') ?? '';
  const t = Number(params.get('t'));
  const f = params.get('filter') as Filter;
  return {
    cam: params.get('cam'),
    cursor: {
      date: DATE.test(date) ? date : today,
      clipId: CLIP.test(clip) ? clip : null,
      offsetSec: Number.isFinite(t) && t > 0 ? Math.floor(t) : 0,
    },
    filter: FILTERS.includes(f) ? f : 'all',
  };
}

export function cursorSearch(c: string, cursor: Cursor, panel: string, filter: Filter): string {
  const p = new URLSearchParams({ cam: c, date: cursor.date });
  if (cursor.clipId) p.set('clip', cursor.clipId);
  p.set('t', String(Math.floor(cursor.offsetSec)));
  p.set('panel', panel);
  p.set('filter', filter);
  return `?${p.toString()}`;
}

export function saveCursor(c: string, cursor: Cursor): void {
  try {
    sessionStorage.setItem(CURSOR_KEY, JSON.stringify({ cam: c, cursor }));
  } catch {
    // not remembered this session
  }
}

export function loadCursor(): { cam: string; cursor: Cursor } | null {
  try {
    const raw = sessionStorage.getItem(CURSOR_KEY);
    return raw ? (JSON.parse(raw) as { cam: string; cursor: Cursor }) : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Verify and commit.** Run `npx vitest run 2>&1 | tail -4 && npm run check`.
```bash
git add web/src/lib/recordings.ts web/src/lib/recordings.test.ts vitest.config.mts
git commit -m "feat: recordings client helpers: timeline layout, cursor URL, filters"
```

---

### Task 6: Recordings workspace UI

**Files:**
- Create:
  - `web/src/components/DayPicker.svelte`
  - `web/src/components/Timeline.svelte`
  - `web/src/components/ClipPlayer.svelte`
  - `web/src/components/EventList.svelte`
  - `web/src/components/DownloadList.svelte`
- Replace: `web/src/pages/Recordings.svelte`
- Modify: `web/src/lib/icons.ts`

**Interfaces:**
- Consumes the Task 5 helpers, `getJson`, the `cameras` and `selectedCameraId` stores, `route` and `navigate`, and `Icon`.
- Produces the test ids listed in the Global Constraints.

- [ ] **Step 1: Icons.** Add these to `ICONS` in `web/src/lib/icons.ts`:
```ts
  play: 'M8 5v14l11-7z',
  pause: 'M8 5h3v14H8zM13 5h3v14h-3z',
  back10: 'M11 7 6 12l5 5M18 7l-5 5 5 5',
  fwd10: 'M13 7l5 5-5 5M6 7l5 5-5 5',
  prev: 'M7 6v12M18 6l-8 6 8 6z',
  next: 'M17 6v12M6 6l8 6-8 6z',
  calendarPrev: 'M15 6l-6 6 6 6',
  calendarNext: 'M9 6l6 6-6 6',
```

- [ ] **Step 2: `web/src/components/DayPicker.svelte`**

```svelte
<script lang="ts">
  import Icon from './Icon.svelte';
  let { date, days, today, onchange }: { date: string; days: string[]; today: string; onchange: (d: string) => void } = $props();
  const prevDay = $derived([...days].filter((d) => d < date).sort().at(-1) ?? null);
  const nextDay = $derived(days.filter((d) => d > date && d <= today).sort()[0] ?? null);
</script>

<div class="picker">
  <button data-testid="day-prev" disabled={!prevDay} onclick={() => prevDay && onchange(prevDay)} aria-label="Previous day with recordings">
    <Icon name="calendarPrev" size={16} />
  </button>
  <input
    type="date"
    data-testid="day-picker"
    value={date}
    max={today}
    onchange={(e) => {
      const v = (e.currentTarget as HTMLInputElement).value;
      if (v) onchange(v);
    }}
  />
  <button data-testid="day-next" disabled={!nextDay} onclick={() => nextDay && onchange(nextDay)} aria-label="Next day with recordings">
    <Icon name="calendarNext" size={16} />
  </button>
</div>

<style>
  .picker { display: inline-flex; align-items: center; gap: 6px; }
  button { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; }
  button:disabled { opacity: 0.4; cursor: default; }
  input { font: inherit; font-size: 14px; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 9px; padding: 5px 10px; color-scheme: inherit; }
</style>
```

- [ ] **Step 3: `web/src/components/Timeline.svelte`**

```svelte
<script lang="ts">
  import { layoutSegments, secondsIntoDay, timelineWindow, type EventClip, type Zoom } from '../lib/recordings';

  let {
    events,
    date,
    selectedId,
    onpick,
    compact = false,
    testid = 'timeline',
  }: {
    events: EventClip[];
    date: string;
    selectedId: string | null;
    onpick: (sec: number) => void;
    compact?: boolean;
    testid?: string;
  } = $props();

  let zoom: Zoom = $state(24);
  const selected = $derived(events.find((e) => e.id === selectedId) ?? null);
  const center = $derived(selected ? secondsIntoDay(selected.start, date) : 43200);
  const win = $derived(timelineWindow(compact ? 24 : zoom, center));
  const segs = $derived(layoutSegments(events, date, win));
  const ticks = $derived.by(() => {
    const step = win.end - win.start > 6 * 3600 ? 3 * 3600 : win.end - win.start > 3600 ? 3600 : 600;
    const out: { left: number; label: string }[] = [];
    for (let s = Math.ceil(win.start / step) * step; s <= win.end; s += step) {
      const h = Math.floor(s / 3600) % 24;
      const m = Math.floor((s % 3600) / 60);
      out.push({ left: ((s - win.start) / (win.end - win.start)) * 100, label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` });
    }
    return out;
  });

  function click(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onpick(win.start + frac * (win.end - win.start));
  }
</script>

<div class="wrap" class:compact>
  {#if !compact}
    <div class="zoom" role="group" aria-label="Timeline zoom">
      {#each [24, 6, 1] as z (z)}
        <button data-testid={`zoom-${z}`} aria-pressed={zoom === z} onclick={() => (zoom = z as Zoom)}>{z} h</button>
      {/each}
    </div>
  {/if}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="bar" data-testid={testid} role="slider" tabindex="0" aria-label="Recordings timeline" aria-valuemin={0} aria-valuemax={86400} aria-valuenow={Math.round(center)} onclick={click}>
    {#each segs as s (s.id)}
      <span class="seg" class:ai={s.ai} class:on={s.id === selectedId} data-testid="timeline-seg" data-clip-id={s.id} style={`left:${s.left}%;width:${s.width}%`}></span>
    {/each}
    <div class="ticks">
      {#each ticks as t (t.left)}<span style={`left:${t.left}%`}>{t.label}</span>{/each}
    </div>
  </div>
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: 6px; }
  .zoom { display: flex; gap: 4px; align-self: flex-end; }
  .zoom button { font-size: 12px; padding: 3px 9px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .zoom button[aria-pressed='true'] { background: var(--surface-2); color: var(--text); border-color: var(--accent); }
  .bar { position: relative; height: 46px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); cursor: pointer; overflow: hidden; }
  .compact .bar { height: 30px; }
  .seg { position: absolute; top: 8px; height: 18px; border-radius: 4px; background: color-mix(in srgb, var(--accent-2) 60%, transparent); transition: transform 0.15s ease; }
  .compact .seg { top: 6px; height: 12px; }
  .seg.ai { background: var(--accent); }
  .seg.on { outline: 2px solid var(--text); outline-offset: 1px; }
  .ticks { position: absolute; left: 0; right: 0; bottom: 2px; height: 12px; pointer-events: none; }
  .ticks span { position: absolute; transform: translateX(-50%); font-size: 10px; color: var(--muted); font-family: var(--mono); }
  .compact .ticks { display: none; }
</style>
```

- [ ] **Step 4: `web/src/components/ClipPlayer.svelte`**

```svelte
<script lang="ts">
  import Icon from './Icon.svelte';

  let {
    src,
    startAt = 0,
    hasPrev,
    hasNext,
    onprev,
    onnext,
    ontime,
    downloadHref,
  }: {
    src: string | null;
    startAt?: number;
    hasPrev: boolean;
    hasNext: boolean;
    onprev: () => void;
    onnext: () => void;
    ontime: (sec: number) => void;
    downloadHref: string | null;
  } = $props();

  let video: HTMLVideoElement | undefined = $state();
  let playing = $state(false);
  let current = $state(0);
  let loadedSrc: string | null = null;

  $effect(() => {
    if (!video || !src || src === loadedSrc) return;
    loadedSrc = src;
    const v = video;
    const at = startAt;
    v.src = src;
    v.addEventListener(
      'loadedmetadata',
      () => {
        if (at > 0 && at < v.duration) v.currentTime = at;
        void v.play().catch(() => (playing = false));
      },
      { once: true },
    );
  });

  function toggle() {
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }
  function skip(d: number) {
    if (video) video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + d));
  }
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
</script>

<div class="player">
  {#if src}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={video}
      data-testid="clip-video"
      playsinline
      muted
      onplay={() => (playing = true)}
      onpause={() => (playing = false)}
      ontimeupdate={() => {
        current = video?.currentTime ?? 0;
        ontime(current);
      }}
      onended={() => hasNext && onnext()}
    ></video>
  {:else}
    <div class="empty">Select a recording on the timeline or in the list.</div>
  {/if}
  <div class="controls">
    <button data-testid="prev-clip" disabled={!hasPrev} onclick={onprev} title="Previous recording"><Icon name="prev" size={16} /></button>
    <button data-testid="back-10" disabled={!src} onclick={() => skip(-10)} title="Back 10 seconds"><Icon name="back10" size={16} /><span>10</span></button>
    <button data-testid="play-toggle" class="primary" disabled={!src} onclick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
      <Icon name={playing ? 'pause' : 'play'} size={18} />
    </button>
    <button data-testid="fwd-10" disabled={!src} onclick={() => skip(10)} title="Forward 10 seconds"><span>10</span><Icon name="fwd10" size={16} /></button>
    <button data-testid="next-clip" disabled={!hasNext} onclick={onnext} title="Next recording"><Icon name="next" size={16} /></button>
    <span class="time" data-testid="clip-time">{clock(current)}</span>
    {#if downloadHref}<a class="dl" href={downloadHref} download title="Download (full quality)"><Icon name="downloads" size={16} /></a>{/if}
  </div>
</div>

<style>
  .player { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  video, .empty { width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; }
  .empty { display: grid; place-items: center; color: var(--muted); background: var(--surface); border: 1px dashed var(--border); padding: 12px; text-align: center; }
  .controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  button, .dl {
    display: inline-flex; align-items: center; gap: 4px; height: 34px; padding: 0 10px; border-radius: 9px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 12px; cursor: pointer;
    transition: background-color 0.15s ease;
  }
  button:disabled { opacity: 0.4; cursor: default; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  .time { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-left: 4px; }
  .dl { margin-left: auto; }
</style>
```

- [ ] **Step 5: `web/src/components/EventList.svelte`**

```svelte
<script lang="ts">
  import { FILTERS, TRIGGER_LABELS, formatClock, thumbUrl, type EventClip, type Filter } from '../lib/recordings';

  let {
    cameraId,
    events,
    filter,
    selectedId,
    onfilter,
    onselect,
  }: {
    cameraId: string;
    events: EventClip[];
    filter: Filter;
    selectedId: string | null;
    onfilter: (f: Filter) => void;
    onselect: (e: EventClip) => void;
  } = $props();

  let broken = $state(new Set<string>());
</script>

<div class="filters" role="group" aria-label="Filter events">
  {#each FILTERS as f (f)}
    <button data-testid={`filter-${f}`} aria-pressed={filter === f} onclick={() => onfilter(f)}>{f === 'all' ? 'All' : TRIGGER_LABELS[f]}</button>
  {/each}
</div>

{#if events.length === 0}
  <p class="none" data-testid="no-events">No {filter === 'all' ? '' : TRIGGER_LABELS[filter].toLowerCase() + ' '}events on this day.</p>
{:else}
  <ul class="list">
    {#each events as e (e.id)}
      <li>
        <button class="card" data-testid="event-card" data-clip-id={e.id} aria-current={e.id === selectedId ? 'true' : undefined} onclick={() => onselect(e)}>
          {#if broken.has(e.id)}
            <span class="thumb placeholder" data-testid="event-thumb"></span>
          {:else}
            <img class="thumb" data-testid="event-thumb" loading="lazy" alt="" src={thumbUrl(cameraId, e.id)} onerror={() => (broken = new Set([...broken, e.id]))} />
          {/if}
          <span class="meta">
            <strong>{formatClock(e.start)}</strong>
            <span class="dur">{e.durationSec} s</span>
            <span class="tags">
              {#each e.triggers as t (t)}<span class="tag" class:ai={t !== 'motion' && t !== 'timer'}>{TRIGGER_LABELS[t]}</span>{/each}
            </span>
          </span>
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .filters { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px; }
  .filters button { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .filters button[aria-pressed='true'] { background: var(--surface-2); color: var(--text); border-color: var(--accent); }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .card {
    width: 100%; display: flex; gap: 10px; align-items: center; padding: 6px; border-radius: 10px; text-align: left;
    border: 1px solid var(--border); background: var(--surface); cursor: pointer; transition: border-color 0.15s ease, background-color 0.15s ease;
  }
  .card:hover { background: var(--surface-2); }
  .card[aria-current='true'] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); }
  .thumb { width: 96px; height: 54px; object-fit: cover; border-radius: 6px; background: var(--surface-2); flex: none; }
  .placeholder { display: block; }
  .meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 13px; }
  .dur { color: var(--muted); font-size: 12px; }
  .tags { display: flex; gap: 4px; flex-wrap: wrap; }
  .tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--accent-2) 22%, transparent); color: var(--text); }
  .tag.ai { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .none { color: var(--muted); font-size: 14px; }
</style>
```

- [ ] **Step 6: `web/src/components/DownloadList.svelte`**

```svelte
<script lang="ts">
  import { downloadUrl, formatBytes, formatClock, type EventClip } from '../lib/recordings';

  let { cameraId, events, selectedId }: { cameraId: string; events: EventClip[]; selectedId: string | null } = $props();

  // The selected recording and its neighbours: the cursor decides what's offered.
  const around = $derived.by(() => {
    const i = Math.max(0, events.findIndex((e) => e.id === selectedId));
    return events.slice(Math.max(0, i - 3), i + 4);
  });
</script>

{#if events.length === 0}
  <p class="none">No recordings on this day.</p>
{:else}
  <ul class="rows">
    {#each around as e (e.id)}
      <li class="row" data-testid="download-row" data-clip-id={e.id} aria-current={e.id === selectedId ? 'true' : undefined}>
        <span class="when">{formatClock(e.start)} · {e.durationSec} s</span>
        <a data-testid="download-sub" href={downloadUrl(cameraId, e.id, 'sub')} download>SD <small>{formatBytes(e.sizeSub)}</small></a>
        <a data-testid="download-main" href={downloadUrl(cameraId, e.id, 'main')} download>Full <small>{formatBytes(e.sizeMain)}</small></a>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .rows { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); font-size: 13px; }
  .row[aria-current='true'] { border-color: var(--accent); }
  .when { flex: 1; font-family: var(--mono); font-size: 12px; }
  a { padding: 4px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); text-decoration: none; font-size: 12px; }
  a:hover { border-color: var(--accent); }
  small { color: var(--muted); }
  .none { color: var(--muted); font-size: 14px; }
</style>
```

- [ ] **Step 7: Replace `web/src/pages/Recordings.svelte`**

```svelte
<script lang="ts">
  import DayPicker from '../components/DayPicker.svelte';
  import Timeline from '../components/Timeline.svelte';
  import ClipPlayer from '../components/ClipPlayer.svelte';
  import EventList from '../components/EventList.svelte';
  import DownloadList from '../components/DownloadList.svelte';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { navigate, route, type Panel } from '../lib/router';
  import { getJson } from '../lib/api';
  import {
    clipAtSecond, cursorSearch, daysUrl, downloadUrl, eventsUrl, filterEvents, loadCursor, localDate,
    neighbour, parseCursor, saveCursor, secondsIntoDay, videoUrl, type Cursor, type EventClip, type Filter,
  } from '../lib/recordings';

  const today = localDate(new Date());
  const TABS: { id: Panel; label: string }[] = [
    { id: 'history', label: 'History' },
    { id: 'events', label: 'Events' },
    { id: 'downloads', label: 'Downloads' },
  ];

  let events: EventClip[] = $state([]);
  let days: string[] = $state([]);
  let loading = $state(true);
  let failed = $state(false);
  let eventsRequest = 0;

  // The URL is the source of truth; with none (e.g. a sidebar link), the
  // last cursor of this session is restored.
  const parsed = $derived.by(() => {
    const p = parseCursor($route.params, today);
    if (!$route.params.has('date') && !$route.params.has('clip')) {
      const saved = loadCursor();
      if (saved && (!p.cam || saved.cam === p.cam)) return { ...p, cam: saved.cam, cursor: saved.cursor };
    }
    return p;
  });
  const cam = $derived(parsed.cam && $cameras.some((c) => c.id === parsed.cam) ? parsed.cam : $selectedCameraId);
  const cursor: Cursor = $derived(parsed.cursor);
  const filter: Filter = $derived(parsed.filter);
  const panel: Panel = $derived($route.panel);
  const visible = $derived(filterEvents(events, filter));
  const selected = $derived(events.find((e) => e.id === cursor.clipId) ?? null);

  function go(next: Partial<Cursor>, opts: { panel?: Panel; filter?: Filter } = {}) {
    if (!cam) return;
    const c: Cursor = { ...cursor, ...next };
    saveCursor(cam, c);
    navigate(`/app/recordings${cursorSearch(cam, c, opts.panel ?? panel, opts.filter ?? filter)}`);
  }

  // Keep the picker and the page's camera in step.
  $effect(() => {
    if (parsed.cam && parsed.cam !== $selectedCameraId && $cameras.some((c) => c.id === parsed.cam)) selectedCameraId.set(parsed.cam);
  });

  $effect(() => {
    const c = cam;
    const date = cursor.date;
    if (!c) return;
    const seq = ++eventsRequest;
    loading = true;
    failed = false;
    Promise.all([getJson<{ events: EventClip[] }>(eventsUrl(c, date)), getJson<{ days: string[] }>(daysUrl(c, date.slice(0, 7)))])
      .then(([e, d]) => {
        if (seq !== eventsRequest) return;
        events = e.events;
        days = [...new Set([...d.days, ...(date.slice(0, 7) !== today.slice(0, 7) ? [] : [])])];
      })
      .catch(() => {
        if (seq === eventsRequest) failed = true;
      })
      .finally(() => {
        if (seq === eventsRequest) loading = false;
      });
  });

  let lastT = 0;
  function onTime(sec: number) {
    if (!cam || Math.abs(sec - lastT) < 2) return;
    lastT = sec;
    saveCursor(cam, { ...cursor, offsetSec: sec });
  }

  function pickSecond(sec: number) {
    const e = clipAtSecond(events, cursor.date, sec);
    if (e) go({ clipId: e.id, offsetSec: Math.max(0, Math.floor(sec - secondsIntoDay(e.start, cursor.date))) });
  }
</script>

<section class="page">
  <header class="head">
    <h1 data-testid="page-title">Recordings</h1>
    {#if cam}<DayPicker date={cursor.date} {days} {today} onchange={(d) => go({ date: d, clipId: null, offsetSec: 0 })} />{/if}
  </header>

  {#if !cam}
    <div class="placeholder">No cameras are configured.</div>
  {:else}
    <div class="workspace" data-panel={panel}>
      <div class="main">
        <ClipPlayer
          src={selected ? videoUrl(cam, selected.id) : null}
          startAt={cursor.offsetSec}
          hasPrev={!!(selected && neighbour(events, selected.id, -1))}
          hasNext={!!(selected && neighbour(events, selected.id, 1))}
          onprev={() => { const p = selected && neighbour(events, selected.id, -1); if (p) go({ clipId: p.id, offsetSec: 0 }); }}
          onnext={() => { const n = selected && neighbour(events, selected.id, 1); if (n) go({ clipId: n.id, offsetSec: 0 }); }}
          ontime={onTime}
          downloadHref={selected ? downloadUrl(cam, selected.id, 'main') : null}
        />
        {#if loading}
          <div class="bar-skeleton" aria-busy="true"></div>
        {:else if failed}
          <p class="note" role="alert">The recordings could not be loaded. The camera may be offline.</p>
        {:else if events.length === 0}
          <p class="note" data-testid="no-recordings">No recordings on {cursor.date}.</p>
        {:else}
          <Timeline {events} date={cursor.date} selectedId={cursor.clipId} onpick={pickSecond} />
        {/if}
      </div>

      <aside class="side">
        <div class="tabs" role="tablist">
          {#each TABS as tab (tab.id)}
            <button role="tab" data-testid={`panel-tab-${tab.id}`} aria-selected={panel === tab.id} class:on={panel === tab.id} onclick={() => go({}, { panel: tab.id })}>{tab.label}</button>
          {/each}
        </div>
        {#if panel === 'downloads'}
          <DownloadList cameraId={cam} {events} selectedId={cursor.clipId} />
        {:else}
          <EventList cameraId={cam} events={visible} {filter} selectedId={cursor.clipId}
            onfilter={(f) => go({}, { filter: f })}
            onselect={(e) => go({ clipId: e.id, offsetSec: 0 })} />
        {/if}
      </aside>
    </div>
  {/if}
</section>

<style>
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .head h1 { margin: 0; }
  .workspace { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; align-items: start; }
  .main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .side { display: flex; flex-direction: column; gap: 10px; max-height: calc(100vh - 170px); overflow: auto; }
  .tabs { display: flex; gap: 6px; }
  .tabs button { padding: 6px 14px; border-radius: 9px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; }
  .tabs button.on { background: var(--surface-2); color: var(--text); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .note { color: var(--muted); margin: 0; }
  .bar-skeleton { height: 46px; border-radius: 10px; background: linear-gradient(90deg, var(--surface-2), var(--surface), var(--surface-2)); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: 0 0; } }
  @media (max-width: 1199px) {
    .workspace { grid-template-columns: 1fr; }
    .side { max-height: none; }
  }
</style>
```

- [ ] **Step 8: Verify and commit.** Run `npm run build` (no Svelte warnings; fix any the compiler reports, keeping behaviour and test ids, and list the fixes), then `npm run check` and `npx vitest run 2>&1 | tail -4`.
```bash
git add web
git commit -m "feat: recordings workspace: day picker, timeline, clip player, events and downloads"
```

---

### Task 7: Live page mini timeline, and e2e for the workspace

**Files:**
- Modify: `web/src/pages/Live.svelte`, `e2e/shell.spec.ts` (the old "recordings panel tabs switch the panel" test moves to `recordings.spec.ts`)
- Create: `e2e/recordings.spec.ts`

**Interfaces:**
- Consumes `Timeline` (with `compact` and `testid`), the recordings helpers, and the mock camera's default clips (Task 2).

- [ ] **Step 1: Mini timeline on Live.** In `web/src/pages/Live.svelte`, load today's events for the selected camera. Show them under the viewer:
```svelte
<script lang="ts">
  // add to the existing imports
  import Timeline from '../components/Timeline.svelte';
  import { clipAtSecond, cursorSearch, eventsUrl, localDate, saveCursor, type EventClip } from '../lib/recordings';
  import { navigate } from '../lib/router';

  const today = localDate(new Date());
  let todayEvents: EventClip[] = $state([]);
  let eventsSeq = 0;
  $effect(() => {
    const id = $selectedCameraId;
    todayEvents = [];
    if (!id) return;
    const seq = ++eventsSeq;
    getJson<{ events: EventClip[] }>(eventsUrl(id, today)).then((r) => { if (seq === eventsSeq) todayEvents = r.events; }).catch(() => {});
  });
  function openRecording(sec: number) {
    const id = $selectedCameraId;
    const e = clipAtSecond(todayEvents, today, sec);
    if (!id || !e) return;
    const c = { date: today, clipId: e.id, offsetSec: 0 };
    saveCursor(id, c);
    navigate(`/app/recordings${cursorSearch(id, c, 'history', 'all')}`);
  }
</script>
```
Inside the `status?.online` branch, after the `.meta` paragraph:
```svelte
      <div class="today">
        <span class="label">Today</span>
        {#if todayEvents.length}
          <Timeline events={todayEvents} date={today} selectedId={null} onpick={openRecording} compact testid="live-timeline" />
        {:else}
          <span class="none">No recordings yet today.</span>
        {/if}
      </div>
```
Styles:
```css
  .today { display: flex; flex-direction: column; gap: 4px; }
  .today .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .today .none { font-size: 13px; color: var(--muted); }
```

- [ ] **Step 2: `e2e/recordings.spec.ts`**

```ts
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './session';

// The mock camera's default clips (test/mock-camera/server.ts, DEFAULT_MOCK_CLIPS):
// today 08:15:10 person, 09:30:00 vehicle, 12:05:05 motion, 17:45:40 pet;
// yesterday 07:00:00 motion, 22:15:10 person. Browser zone = America/Chicago.
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

async function openEvents(page: Page) {
  await page.goto('/app/recordings?panel=events');
  await expect(page.getByTestId('event-card')).toHaveCount(4);
}

test('events list shows today\'s recordings with triggers and thumbnails', async ({ page }) => {
  await openEvents(page);
  await expect(page.getByTestId('event-card').first()).toContainText('08:15:10');
  await expect(page.getByTestId('event-card').first()).toContainText('Person');
  const thumb = page.getByTestId('event-thumb').first();
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
});

test('selecting an event plays it and puts it in the URL', async ({ page }) => {
  await openEvents(page);
  await page.getByTestId('event-card').nth(2).click();
  await expect(page).toHaveURL(/clip=\d{8}-120505-120530/);
  const video = page.getByTestId('clip-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.currentTime > 0.5), { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId('event-card').nth(2)).toHaveAttribute('aria-current', 'true');
});

test('skip, pause and next/previous recording work', async ({ page }) => {
  await openEvents(page);
  await page.getByTestId('event-card').first().click();
  const video = page.getByTestId('clip-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime > 0.3), { timeout: 15_000 }).toBe(true);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const before = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.getByTestId('fwd-10').click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(before + 5);
  await page.getByTestId('back-10').click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(before + 5);
  await page.getByTestId('next-clip').click();
  await expect(page).toHaveURL(/clip=\d{8}-093000-093020/);
  await page.getByTestId('prev-clip').click();
  await expect(page).toHaveURL(/clip=\d{8}-081510-081535/);
});

test('filters narrow the list and an empty filter says so', async ({ page }) => {
  await openEvents(page);
  await page.getByTestId('filter-person').click();
  await expect(page.getByTestId('event-card')).toHaveCount(1);
  await expect(page).toHaveURL(/filter=person/);
  await page.getByTestId('filter-all').click();
  await expect(page.getByTestId('event-card')).toHaveCount(4);
});

test('the cursor carries across panels and back from another page', async ({ page }, testInfo) => {
  await openEvents(page);
  await page.getByTestId('event-card').nth(1).click();
  await page.getByTestId('panel-tab-downloads').click();
  await expect(page.getByTestId('download-row').filter({ has: page.locator('[aria-current="true"]') }).or(
    page.locator('[data-testid="download-row"][aria-current="true"]'),
  )).toHaveCount(1);
  await expect(page.locator('[data-testid="download-row"][aria-current="true"]')).toHaveAttribute('data-clip-id', /-093000-093020$/);
  // leave and come back through the menu
  if (testInfo.project.name === 'phone') {
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-live').click();
    await page.getByTestId('hamburger').click();
    await page.getByTestId('drawer').getByTestId('nav-events').click();
  } else {
    await page.getByTestId('sidebar').getByTestId('nav-live').click();
    await page.getByTestId('sidebar').getByTestId('nav-events').click();
  }
  await expect(page.locator('[data-testid="event-card"][aria-current="true"]')).toHaveAttribute('data-clip-id', /-093000-093020$/);
});

test('a deep link restores the selection after reload', async ({ page }) => {
  await openEvents(page);
  await page.getByTestId('event-card').nth(3).click();
  const url = page.url();
  await page.goto(url);
  await expect(page.locator('[data-testid="event-card"][aria-current="true"]')).toHaveAttribute('data-clip-id', /-174540-174605$/);
});

test('clicking the timeline selects the recording under the click', async ({ page }) => {
  await page.goto('/app/recordings?panel=history');
  const seg = page.getByTestId('timeline-seg').nth(2);
  await expect(seg).toBeVisible();
  const box = (await seg.boundingBox())!;
  await page.getByTestId('timeline').click({ position: { x: box.x - (await page.getByTestId('timeline').boundingBox())!.x + box.width / 2, y: 20 } });
  await expect(page).toHaveURL(/clip=\d{8}-120505-120530/);
});

test('previous day shows yesterday\'s recordings; a day without any says so', async ({ page }) => {
  await openEvents(page);
  await page.getByTestId('day-prev').click();
  await expect(page.getByTestId('event-card')).toHaveCount(2);
  await page.goto('/app/recordings?date=2001-01-01&panel=events');
  await expect(page.getByTestId('no-recordings')).toBeVisible();
});

test('downloads return MP4 attachments with readable names', async ({ page }) => {
  await page.goto('/app/recordings?panel=downloads');
  const href = await page.getByTestId('download-main').first().getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('video/mp4');
  expect(res.headers()['content-disposition']).toMatch(/^attachment; filename="cam1-\d{4}-\d{2}-\d{2}_08-15-10-main\.mp4"$/);
});

test('the Live page mini timeline opens a recording', async ({ page }) => {
  await page.goto('/app/live');
  const seg = page.getByTestId('live-timeline').getByTestId('timeline-seg').first();
  await expect(seg).toBeVisible();
  const bar = (await page.getByTestId('live-timeline').boundingBox())!;
  const s = (await seg.boundingBox())!;
  await page.getByTestId('live-timeline').click({ position: { x: s.x - bar.x + s.width / 2, y: bar.height / 2 } });
  await expect(page).toHaveURL(/\/app\/recordings\?.*clip=\d{8}-081510-081535/);
});
```
In `e2e/shell.spec.ts`, delete the old `recordings panel tabs switch the panel` test. Panel switching is now covered by the cursor test.

- [ ] **Step 3: Run the suite.** Run `npm run build && npm run test:e2e`. It must be green on every project, twice. Also run `npx vitest run 2>&1 | tail -4`. Ports 8098 and 8099 must be free afterwards.

- [ ] **Step 4: Commit**
```bash
git add web/src/pages/Live.svelte e2e
git commit -m "feat: Live mini timeline; e2e for the recordings workspace"
```

---

### Task 8 (controller, ops): cluster cache volume, ship, verify

- [ ] **Step 1: Ask kube-setup** (before the deploy) to update the cams ksvc:
  - Add an `emptyDir` volume with `sizeLimit: 2Gi`, mounted at `/var/cache/cams` and writable by uid 1000 (`fsGroup: 1000` in the pod securityContext, or equivalent).
  - Set env `CACHE_DIR=/var/cache/cams` and `CACHE_MAX_BYTES=1610612736`.
  - Raise the memory limit to 384Mi, because ffmpeg thumbnailing runs in the pod.
  - Push the change before applying it. Confirm the live ksvc matches git.
- [ ] **Step 2: Gate, then ship.**
  - Run the full local gate: `npm ci`, vitest, build, check, audit, e2e.
  - Open a PR from the branch to `main`. When `test`, `e2e` and `codeql` are green on CI, merge it.
  - Open a PR from `main` to `production`. When it's green, merge it and watch the deploy.
- [ ] **Step 3: Verify on the real camera.**
  - The pod logs must show no `camera_request_failed` after opening Recordings.
  - Klaus checks the following:
    - Today's events appear with thumbnails and "Motion" tags, since the camera records on motion only.
    - A clip plays, and ±10 s and next/previous work.
    - "Full" downloads the H.265 main clip.
    - Moving from Events to Downloads keeps the selected clip.
    - The mini timeline on Live opens a recording.
    - On a phone, fullscreen uses the video's own player.
- [ ] **Step 4: Records.**
  - Update the Obsidian note `Cameras/Reolink API Behaviour` with the Download 401 shape and the flag bit layout (from this plan's camera facts).
  - Put the follow-ups in `docs/superpowers/plans/2026-09-26-cams-3-followups.md`.
