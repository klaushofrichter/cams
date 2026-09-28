# Unified Video Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live, History and Downloads become one page. The video, the info line and the strip stay in place, and the menu switches only the right panel. Live is the strip's right end ("glued" to now). The batch also adds a 30-minute zoom, and cam-sim now identifies itself in its device info.

**Architecture:**
- **Video page:** `Recordings.svelte` becomes `Video.svelte`, with panels `live | history | downloads`. The Live page's player logic moves into `LiveBox.svelte`, which renders inside the strip player's box, and `LivePanel.svelte` (the right panel).
- **Glue:** `HistoryView` owns a `glued` flag. While glued, the playhead follows now and the box shows the live stream.
- **Keep-alive:** App keeps the Video page mounted after the user leaves it, as it kept Live mounted. Inside the page, the live stream follows the same keep-alive rule after the user moves into playback.
- **The live `<video>` is never moved in the DOM:** that would pause it.

**Tech Stack:** Svelte 5 (runes), TypeScript, vitest (+jsdom), Playwright, Express 5; cam-sim (a Node/TS repo) for one field.

**Spec:** `docs/superpowers/specs/2026-09-28-unified-video-page-design.md`

## Global Constraints

- Same player column position and size on the Live, History and Downloads panels (`--player-max-w`). Spacers fill any extra width, so the right panel sits against the right edge. Phones: one column, no spacers.
- URLs: `/app/live` opens the live panel glued. `/app/recordings?panel=history|downloads&cam&date&at` as today; `panel=events` still maps to history.
- Menu unchanged: Live, History, Downloads, Timeline, Settings, About. Page titles: `Live` on the live panel, `Recordings` on the others (the e2e shell test relies on it).
- Keep-alive (Klaus): leaving the live stream, to playback or another page, keeps it open in the background for the setting (0–15 min). Returning within that time shows it at once.
- Zooms: `24, 12, 6, 3, 1, 0.5` hours. The server accepts `0.5`; Settings offers "30 minutes".
- cam-sim's `GetDevInfo` gains exactly one field: `simulator: "cam-sim"`.
  - **Ruling:** no version in the value. cam-sim stores no version in its sources (the release generates it).
  - cams shows "Simulated camera" when that field is present.
- Existing test ids keep their meaning:
  - `live-video`, `live-badge` (text `● LIVE`, `● STILLS`, `● …`), `live-state`, `mute-toggle`, `quality-toggle`, `snapshot`, `snapshot-error`, `fullscreen`, `offline-banner`, `offline-reason`, `retry`, `stream-indicator`;
  - all strip and player ids (`clip-video`, `timeline`, `strip-*`, `source-badge`, …).
- CLAUDE.md: colours from `theme.css`; every new element used by e2e gets a `data-testid`; e2e at 1440×900 and 390×844; no Playwright on the self-hosted runner.

## Review Focus

- **Keep-alive with three ways to leave:** Live → History panel (unglue), Live → Settings (page), and a hidden tab. Coming back within the time must reuse the same stream (no second `/live` request). Pinned in Task 7 (e2e, rewritten live-keepalive).
- **Switching camera while the live stream is kept alive in the background:** the old stream ends at once, as today. Pinned in Task 7 (the existing e2e moved over).
- **Glue edges:** a click or drag landing past now re-glues, only on the live panel; History never glues. Playback reaching now on the live panel re-glues. Pinned in Task 4.
- **An offline camera on the live panel:** the offline banner and Retry are in the panel, and the strip still works (playback of older recordings). Pinned in Task 6/7.
- **Fullscreen while leaving live:** exit fullscreen when the live box is hidden (existing behaviour, moved). Pinned in Task 5 (component).

---

## File Structure

| File | Responsibility |
|---|---|
| cam-sim `src/profile/rlc1224a.ts` | `devInfo` gains `simulator: 'cam-sim'` |
| `server/reolink/client.ts` (`status`) | also reports `simulator` and the streams (`GetEnc`, cached) |
| `web/src/lib/strip.ts`, `server/preferences.ts`, `web/src/lib/preferences.ts`, `web/src/lib/recordings.ts`, `web/src/pages/Settings.svelte` | the 0.5 h zoom |
| `web/src/lib/liveUi.ts` (new) | a store shared by the LiveBox and LivePanel: quality, muted, player state, stills showing, status; snapshot and fullscreen actions |
| `web/src/components/LiveBox.svelte` (new) | the live video (LivePlayer + LiveStill fallback), status polling, live status publishing; moved from `Live.svelte` |
| `web/src/components/LivePanel.svelte` (new) | the right panel on Live: camera info, latest event, controls, offline banner |
| `web/src/components/HistoryView.svelte` | glue: `live` and `glued` props, now-following, unglue and re-glue rules, the LiveBox slot |
| `web/src/components/StripPlayer.svelte` | a `live` snippet shown in the box while glued; the info line `● LIVE · SD 10 FPS` |
| `web/src/components/Strip.svelte` | ⇥ on the live panel glues (`onglue`) |
| `web/src/pages/Video.svelte` (from `Recordings.svelte`) | panels live/history/downloads, spacers, title |
| `web/src/App.svelte` | mounts Video for pages live and recordings; keep-alive for the Video page |
| `web/src/pages/Live.svelte`, `web/src/components/Timeline.svelte` (+ test) | deleted |
| `web/src/lib/router.ts` | page `live` and `recordings` both route to Video (panel live for `/app/live`) |
| e2e `live.spec.ts`, `live-keepalive.spec.ts`, `live-teardown.spec.ts`, `recordings.spec.ts`, `shell.spec.ts` | moved over to the one page |

---

### Task 1: cam-sim says it is a simulator

**Repo:** `~/Development/cam-sim`, branch `feat/simulator-field`.

**Files:**
- Modify: `src/profile/rlc1224a.ts:17-24`
- Test: `test/profile.test.ts`
- Docs: `README.md` (the simulated camera API section), `CHANGELOG.md`

**Interfaces:**
- Produces: `GetDevInfo` → `DevInfo.simulator === 'cam-sim'` (the ONVIF device info unchanged).

- [ ] **Step 1: Write the failing test** (append to `test/profile.test.ts`)

```ts
import { devInfo } from '../src/profile/rlc1224a';

describe('devInfo identifies the simulator (cams labels it, Klaus 2026-09-28)', () => {
  it('adds simulator: cam-sim and changes nothing else', () => {
    const d = devInfo('Den', 'SERIAL', 'v3.2.0.6011_2607012059') as Record<string, unknown>;
    expect(d.simulator).toBe('cam-sim');
    expect(d.model).toBe('RLC-1224A');
    expect(Object.keys(d)).toHaveLength(22); // the real camera's 21 keys + simulator
  });
});
```

(If `test/profile.test.ts` already imports from `vitest`, reuse that import line; add `describe, it, expect` to it if missing.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/profile.test.ts`
Expected: FAIL (`simulator` is undefined).

- [ ] **Step 3: Implement**

In `src/profile/rlc1224a.ts`, change `devInfo`'s returned object's last line from:

```ts
    model: FIRMWARE.model, name, pakSuffix: 'pak,paks', serial, type: 'IPC', wifi: 0,
```

to:

```ts
    model: FIRMWARE.model, name, pakSuffix: 'pak,paks', serial, type: 'IPC', wifi: 0,
    // The one field a real camera never sends: clients such as cams label the
    // camera as simulated (Klaus, 2026-09-28). Everything else stays identical.
    simulator: 'cam-sim',
```

Check the ONVIF use (`src/onvif/server.ts:107`) only reads named fields: `grep -n "d\." src/onvif/server.ts | head`. It must not serialise the whole object.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass. If a conformance test compares `DevInfo` to a fixed key list, add `simulator` there and ledger a ruling.

- [ ] **Step 5: Docs, commit, PR, merge when green, release**

README: in the simulated camera API section, add "`GetDevInfo` also answers `simulator: \"cam-sim\"`, the one field the real camera doesn't send (clients can label the camera as simulated)." CHANGELOG under `## Unreleased`: the same, one line.

```bash
git add src/profile/rlc1224a.ts test/profile.test.ts README.md CHANGELOG.md
git commit -m "feat: GetDevInfo says simulator: cam-sim"
```

Open a PR to `main`, merge when green, then a release PR `main` → `production` (redeploys cam2). Then bump the cam-sim tarball in **cams** and **cam-proxy** `package.json` (as done for v2026.09.27.3: edit the URL, `npm install`, PR, merge when green).

---

### Task 2: cams reports the simulator and the streams

**Files:**
- Modify: `server/reolink/client.ts` (`status()`, and the `CameraStatus` type wherever it's declared: `grep -n "interface CameraStatus" -r server`)
- Test: `test/cameraRoutes.test.ts` (or wherever `/status` is tested: `grep -ln "/status" test`)

**Interfaces:**
- Produces: `GET /api/cameras/:id/status` → `{ id, online: true, model, firmware, simulator: string | null, streams: { main: StreamInfo | null, sub: StreamInfo | null } }`, where `StreamInfo = { codec: 'h264' | 'h265', width: number, height: number, fps: number }`.

- [ ] **Step 1: Write the failing test** (in the `/status` test file; the sim camera is cam-sim at the bumped version from Task 1)

```ts
  it('says a simulated camera is one, and names its streams (Klaus, 2026-09-28)', async () => {
    const res = await request(createApp()).get('/api/cameras/cam1/status').set('Cookie', auth);
    expect(res.body).toMatchObject({
      online: true,
      simulator: 'cam-sim',
      streams: {
        main: { codec: 'h265', width: 4512, height: 2512, fps: 20 },
        sub: { codec: 'h264', width: 896, height: 512, fps: 10 },
      },
    });
  });
```

(Use the file's existing `auth` constant and camera id. If the file sets up the sim with a different id, use that one.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run <that test file>`
Expected: FAIL (`simulator` and `streams` are missing).

- [ ] **Step 3: Implement** (`server/reolink/client.ts`)

```ts
  // GetEnc changes rarely: asked once per 10 minutes.
  private enc?: { at: number; streams: { main: StreamInfo | null; sub: StreamInfo | null } };

  async status(): Promise<CameraStatus> {
    const value = await this.command<{ DevInfo?: { model?: string; firmVer?: string; simulator?: string } }>('GetDevInfo');
    return {
      model: value.DevInfo?.model ?? 'unknown',
      firmware: value.DevInfo?.firmVer ?? 'unknown',
      // cam-sim's one extra field (a real camera never sends it).
      simulator: typeof value.DevInfo?.simulator === 'string' ? value.DevInfo.simulator : null,
      streams: await this.streams(),
    };
  }

  private async streams(): Promise<{ main: StreamInfo | null; sub: StreamInfo | null }> {
    if (this.enc && Date.now() - this.enc.at < 600_000) return this.enc.streams;
    let streams: { main: StreamInfo | null; sub: StreamInfo | null } = { main: null, sub: null };
    try {
      const v = await this.command<{ Enc?: { mainStream?: RawStream; subStream?: RawStream } }>('GetEnc', { channel: 0 });
      streams = { main: toStream(v.Enc?.mainStream), sub: toStream(v.Enc?.subStream) };
    } catch {
      // the streams are extra information: the status stands without them
    }
    this.enc = { at: Date.now(), streams };
    return streams;
  }
```

At module level in the same file:

```ts
export interface StreamInfo { codec: 'h264' | 'h265'; width: number; height: number; fps: number }
interface RawStream { vType?: string; width?: number; height?: number; frameRate?: number }
function toStream(s: RawStream | undefined): StreamInfo | null {
  if (!s || typeof s.width !== 'number' || typeof s.height !== 'number' || typeof s.frameRate !== 'number') return null;
  return { codec: s.vType === 'h265' ? 'h265' : 'h264', width: s.width, height: s.height, fps: s.frameRate };
}
```

Extend `CameraStatus` with `simulator: string | null; streams: { main: StreamInfo | null; sub: StreamInfo | null }`. Check how `command()` passes parameters (`grep -n "async command" -A6 server/reolink/client.ts`). If it takes `(cmd, param)`, the call above is right; otherwise adapt it to its signature and ledger that.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass. Existing `/status` tests that `toEqual` the whole body gain the two fields. Update them to include `simulator` and `streams`.

- [ ] **Step 5: Commit**

```bash
git add server/reolink/client.ts test/<status test file>
git commit -m "feat: camera status says simulator and names the streams"
```

---

### Task 3: A 30-minute zoom

**Files:**
- Modify: `web/src/lib/strip.ts` (`StripZoom`, `STRIP_ZOOMS`), `web/src/components/Strip.svelte` (tick step and zoom button label), `server/preferences.ts` (type and validation), `web/src/lib/preferences.ts`, `web/src/lib/recordings.ts` (`Zoom`), `web/src/pages/Settings.svelte` (option)
- Test: `web/src/lib/strip.test.ts`, `web/src/components/Strip.svelte.test.ts`, `test/preferences.test.ts`

**Interfaces:**
- Produces: `type StripZoom = 24 | 12 | 6 | 3 | 1 | 0.5`; `STRIP_ZOOMS = [24, 12, 6, 3, 1, 0.5]`; zoom button test id `zoom-0.5`, label `30 min`.

- [ ] **Step 1: Write the failing tests**

`web/src/lib/strip.test.ts`, in the `window and spans` describe:

```ts
  it('has a 30-minute window', () => {
    expect(windowAround(10 * 3_600_000, 0.5)).toEqual({ start: 9.75 * 3_600_000, end: 10.25 * 3_600_000 });
    expect(STRIP_ZOOMS).toEqual([24, 12, 6, 3, 1, 0.5]);
  });
```

(Add `STRIP_ZOOMS` to that file's import from `./strip`.)

`web/src/components/Strip.svelte.test.ts`:

```ts
  it('offers 30 minutes, with ticks every 5 minutes', () => {
    render({});
    preferences.set({ ...PREFS, timelineZoom: 0.5 });
    flushSync();
    expect(q('zoom-0.5')!.textContent).toBe('30 min');
    const labels = [...target!.querySelectorAll('[data-testid="strip-tick"]')].map((e) => e.textContent);
    expect(labels).toContain('12:05');
    expect(labels).toContain('11:50');
  });
```

`test/preferences.test.ts`: in `accepts the strip zooms`, change the list to `[24, 12, 6, 3, 1, 0.5]`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run web/src/lib/strip.test.ts web/src/components/Strip.svelte.test.ts test/preferences.test.ts`
Expected: FAIL in all three.

- [ ] **Step 3: Implement**
- `strip.ts`: `export type StripZoom = 24 | 12 | 6 | 3 | 1 | 0.5;` and `export const STRIP_ZOOMS: StripZoom[] = [24, 12, 6, 3, 1, 0.5];`.
- `Strip.svelte`, the ticks: `const h = $zoom >= 12 ? 3 : $zoom === 6 ? 1 : $zoom === 3 ? 0.5 : $zoom === 1 ? 0.25 : 5 / 60;`.
- `Strip.svelte`, the zoom button text: `{z >= 1 ? `${z} h` : `${z * 60} min`}`.
- `server/preferences.ts`: the type gains `| 0.5`. The validation list becomes `[24, 12, 6, 3, 1, 0.5]`, with the message `'timelineZoom: 24, 12, 6, 3, 1 or 0.5'`.
- `web/src/lib/preferences.ts` and `web/src/lib/recordings.ts` (`Zoom`): add `| 0.5`.
- `Settings.svelte`: append `<option value={0.5}>30 minutes</option>` to `pref-zoom`.

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run check`
Expected: all pass; `check` exits 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/strip.ts web/src/lib/strip.test.ts web/src/components/Strip.svelte web/src/components/Strip.svelte.test.ts server/preferences.ts test/preferences.test.ts web/src/lib/preferences.ts web/src/lib/recordings.ts web/src/pages/Settings.svelte
git commit -m "feat: a 30-minute zoom"
```

---

### Task 4: Glue: the live end of the strip

**Files:**
- Modify: `web/src/components/HistoryView.svelte`, `web/src/components/Strip.svelte`, `web/src/components/StripPlayer.svelte`
- Test: `web/src/components/HistoryView.svelte.test.ts`, `web/src/components/StripPlayer.svelte.test.ts`

**Interfaces:**
- Produces:
  - HistoryView props gain `live?: boolean` (the live panel), `glued?: boolean` (`$bindable`, starts `true` when `live`) and `liveBox?: Snippet` (rendered in the player's box while glued).
  - Strip gains `onglue?: () => void`, called by ⇥ when given (instead of seeking).
  - StripPlayer gains `glued?: boolean` and `live?: Snippet`.
  - While glued, StripPlayer:
    - renders `live` in `.box` over its own layers;
    - hides its `<video>`s and still layers;
    - shows the info line `<span data-testid="live-badge">● LIVE</span>`, where `live-badge`'s text comes from the `liveUi` store (Task 5);
    - disables `play-toggle`.

- [ ] **Step 1: Write the failing tests** (`HistoryView.svelte.test.ts`)

```ts
describe('the live end (glue)', () => {
  it('opens glued on the live panel, following now', async () => {
    const { onposition } = await render({ live: true });
    expect(target!.querySelector('[data-testid="live-badge"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onposition.mock.calls.at(-1)![0]).toBeGreaterThanOrEqual(NOW + 2000 - 3000); // follows now (the 2 s edge)
  });

  it('unglues on any move back, and ⇥ glues again', async () => {
    await render({ live: true });
    (target!.querySelector('[data-testid="back-10"]') as HTMLElement).click();
    flushSync();
    expect(target!.querySelector('[data-testid="live-badge"]')).toBeNull();
    (target!.querySelector('[data-testid="strip-now"]') as HTMLElement).click();
    flushSync();
    expect(target!.querySelector('[data-testid="live-badge"]')).not.toBeNull();
  });

  it('never glues on History', async () => {
    await render({ live: false, initialAt: NOW - 60_000 });
    (target!.querySelector('[data-testid="strip-now"]') as HTMLElement).click();
    flushSync();
    expect(target!.querySelector('[data-testid="live-badge"]')).toBeNull();
  });

  it('playback reaching now on the live panel glues again', async () => {
    await render({ live: true });
    (target!.querySelector('[data-testid="back-10"]') as HTMLElement).click();
    (target!.querySelector('[data-testid="play-toggle"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(15_000);
    flushSync();
    expect(target!.querySelector('[data-testid="live-badge"]')).not.toBeNull();
  });
});
```

(`render` is the file's helper; its `props` gain `live: false` by default.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run web/src/components/HistoryView.svelte.test.ts`
Expected: FAIL (no `live-badge`).

- [ ] **Step 3: Implement**

In `HistoryView.svelte`:

```ts
  // The live end (spec 2026-09-28): on the live panel the playhead starts
  // "glued" to now and the box shows the live stream. Any move back unglues
  // (playback); ⇥ or playback reaching now glues again. History never glues.
  let { /* existing… */ live = false, glued = $bindable(untrack(() => live)), liveBox }: { /* existing… */ live?: boolean; glued?: boolean; liveBox?: Snippet } = $props();
  $effect(() => {
    if (!live) glued = false;
  });
  // While glued the playhead is now (2 s back: the live edge the strip draws).
  $effect(() => {
    if (glued) at = now - 2000;
  });
  // Playback reaching now on the live panel.
  $effect(() => {
    if (live && !glued && playing && at >= now - 2000) {
      playing = false;
      glued = true;
    }
  });
```

In `jump` and `seek`, add `glued = false;` as the first line. Add `glue()`, and on Strip pass `onglue={live ? glue : undefined}`:

```ts
  function glue() {
    if (!live) return;
    glued = true;
    report(true);
  }
```

StripPlayer gets `{glued}` and a `live` snippet wrapping `liveBox`: `<StripPlayer … {glued} live={liveBox}>`. For a move that starts in StripPlayer (±10 s, play), HistoryView watches `at` and unglues:

```ts
  $effect(() => {
    // a move away from now while glued (±10 s in the player) means playback
    if (glued && at < now - 5000) glued = false;
  });
```

(Order matters: declare this after the "glued ⇒ at = now − 2 s" effect.)

In `Strip.svelte`, the ⇥ button: `onclick={() => (onglue ? onglue() : onseek(Math.max(lo, now - 2000)))}`, and it's disabled only when `!onglue && at >= now - 5000`.

In `StripPlayer.svelte`:
- props gain `glued = false, live: liveSnippet` (types `glued?: boolean; live?: import('svelte').Snippet`);
- inside `.box`, after the stills and preview layers, add `{#if glued && liveSnippet}<div class="layer live">{@render liveSnippet()}</div>{/if}`;
- `video` gets `class:hidden={glued || source.kind !== 'clip' || i !== active}`;
- the stills, preview and empty layers render only when `!glued`;
- the info line while glued becomes `<span class="info" data-testid="strip-info"><span data-testid="live-badge">{$liveUi.badge}</span> · <span data-testid="source-badge">{$liveUi.quality === 'main' ? 'HD 20 FPS' : 'SD 10 FPS'}</span></span>`. Until Task 5 adds `liveUi`, use the literal `● LIVE` and `SD 10 FPS`; Task 5 replaces them;
- `play-toggle` is disabled while `glued`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src/components && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/HistoryView.svelte web/src/components/HistoryView.svelte.test.ts web/src/components/Strip.svelte web/src/components/StripPlayer.svelte web/src/components/StripPlayer.svelte.test.ts
git commit -m "feat(video): glue the playhead to now on the live panel"
```

---

### Task 5: LiveBox and the shared live state

**Files:**
- Create: `web/src/lib/liveUi.ts`, `web/src/lib/liveUi.test.ts`, `web/src/components/LiveBox.svelte`, `web/src/components/LiveBox.svelte.test.ts`
- Source of moved code: `web/src/pages/Live.svelte` (it is deleted in Task 7)

**Interfaces:**
- Produces:

```ts
// web/src/lib/liveUi.ts
export interface CameraStatus { id: string; online: boolean; model?: string; firmware?: string; error?: string; simulator?: string | null; streams?: { main: StreamInfo | null; sub: StreamInfo | null } }
export interface StreamInfo { codec: 'h264' | 'h265'; width: number; height: number; fps: number }
export interface LiveUi {
  quality: Quality; muted: boolean; hevc: boolean;
  playerState: PlayerState; stillsShowing: boolean;
  status: CameraStatus | null; checking: boolean;
  badge: string; // '● LIVE' | '● STILLS' | '● …'
  snapshotBusy: boolean; snapshotError: string;
}
export const liveUi: import('svelte/store').Writable<LiveUi>;
export function badgeOf(playerState: PlayerState, stillsShowing: boolean): string;
export function offlineReason(code: string | undefined): string; // moved from Live.svelte
// Actions the LivePanel buttons call; the LiveBox registers the handlers.
export const liveActions: { toggleMute(): void; toggleQuality(): void; snapshot(): void; fullscreen(): void; retry(): void };
export function registerLiveActions(a: Partial<typeof liveActions>): () => void;
```

- `LiveBox.svelte` props: `cameraId: string`, `visible: boolean` (on screen), `audible: boolean`, `proxy: boolean`. It renders `LivePlayer` and, when stuck and `proxy`, the `LiveStill` overlay (the existing `stuck` logic). It polls the status, publishes `liveStatus`, and writes `liveUi`.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/lib/liveUi.test.ts
import { describe, expect, it } from 'vitest';
import { badgeOf, offlineReason } from './liveUi';

describe('liveUi helpers', () => {
  it('names the badge as the Live page did', () => {
    expect(badgeOf('playing', false)).toBe('● LIVE');
    expect(badgeOf('reconnecting', true)).toBe('● STILLS');
    expect(badgeOf('connecting', false)).toBe('● …');
  });
  it('explains each offline code', () => {
    expect(offlineReason('camera_offline')).toBe('The camera could not be reached.');
    expect(offlineReason('camera_auth_failed')).toBe('Signing in to the camera failed.');
    expect(offlineReason('unreachable')).toBe("cams couldn't check the camera (network or server problem).");
    expect(offlineReason('other')).toMatch(/server logs/);
  });
});
```

```ts
// web/src/components/LiveBox.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveBox from './LiveBox.svelte';
import { liveUi } from '../lib/liveUi';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/status') ? { id: 'cam1', online: true, model: 'RLC-1224A', firmware: 'v3', simulator: 'cam-sim', streams: { main: null, sub: null } } : {}), { status: 200 }));
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
});

describe('LiveBox', () => {
  it('checks the camera and shares its status', async () => {
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(LiveBox, { target, props: { cameraId: 'cam1', visible: true, audible: true, proxy: false } });
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(get(liveUi).status).toMatchObject({ online: true, simulator: 'cam-sim' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run web/src/lib/liveUi.test.ts web/src/components/LiveBox.svelte.test.ts`
Expected: FAIL (the modules don't exist).

- [ ] **Step 3: Implement**
- `liveUi.ts`:
  - `liveUi` is a `writable<LiveUi>` with `quality` from `initialQuality()` (moved from `Live.svelte`, lines 38–49; `hevc` computed there too), `muted: true`, `playerState: 'connecting'`, `stillsShowing: false`, `status: null`, `checking: false`, `badge: '● …'`, `snapshotBusy: false`, `snapshotError: ''`.
  - `badgeOf` returns `playerState === 'playing' ? '● LIVE' : stillsShowing ? '● STILLS' : '● …'`.
  - `offlineReason` is moved verbatim from `Live.svelte`.
  - `liveActions` delegates to handlers set by `registerLiveActions`; the default is no-ops. `registerLiveActions` returns a function that restores the no-ops.
- `LiveBox.svelte`: move from `Live.svelte`:
  - the `stuck` effect, `checkStatus` with its sequence guard, and the status effect on `cameraId`;
  - `toggleQuality` (it writes `liveUi` and `localStorage`), `fullscreen` (on the box element), `saveSnapshot`;
  - the fullscreen-exit effect when `!visible`;
  - the `liveStatus` publishing effect and `onDestroy`.
  - It registers `liveActions` on mount and unregisters on destroy.
  - It keeps `liveUi.status/checking/playerState/stillsShowing/badge/snapshotBusy/snapshotError` up to date.
  - Markup:

  ```svelte
  <div class="livebox" bind:this={box}>
    {#if $liveUi.status?.online}
      <LivePlayer {cameraId} quality={$liveUi.quality} muted={$liveUi.muted || !audible} onstate={(s) => setState(s)} />
      {#if proxy && stuck}<LiveStill {cameraId} active={visible} overlay onactive={(on) => setStills(on)} />{/if}
    {:else if $liveUi.status && !$liveUi.status.online && proxy}
      <LiveStill {cameraId} active={visible} onactive={(on) => setStills(on)} />
    {/if}
  </div>
  ```

  Styling: `.livebox { position: absolute; inset: 0; }`, and the player fills it. Colours only from tokens.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src && npm run check`
Expected: all pass. `Live.svelte` still exists and is unchanged until Task 7.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/liveUi.ts web/src/lib/liveUi.test.ts web/src/components/LiveBox.svelte web/src/components/LiveBox.svelte.test.ts
git commit -m "feat(video): LiveBox and the shared live state"
```

---

### Task 6: The Live panel

**Files:**
- Create: `web/src/components/LivePanel.svelte`, `web/src/components/LivePanel.svelte.test.ts`

**Interfaces:**
- Consumes: `liveUi`, `liveActions` (Task 5); `thumbUrl`, `EventClip`, `TRIGGER_LABELS` (`recordings.ts`); `timeAgo` (`clock.ts`); the `pending` list type from `eventStream.ts`.
- Produces: `<LivePanel camera={CameraSummary} latest={EventClip | null} pending={Pending[]} onplay={(e: EventClip) => void} proxyInfo={{ reachable: boolean; webUrl: string | null } | null} />`.
- Test ids:
  - `live-panel`, `live-camera-name`, `live-camera-kind` ("Simulated camera" or "Camera"), `live-camera-model`, `live-camera-streams`, `live-latest`, `live-latest-ago`;
  - the moved `mute-toggle`, `quality-toggle`, `snapshot`, `snapshot-error`, `fullscreen`, `offline-banner`, `offline-reason`, `retry`, `live-state`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/components/LivePanel.svelte.test.ts
// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LivePanel from './LivePanel.svelte';
import { liveUi } from '../lib/liveUi';
import { get } from 'svelte/store';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
});
const ev = { id: '20260928-091953-092013', start: new Date(Date.now() - 12 * 60_000).toISOString(), end: new Date(Date.now() - 11 * 60_000).toISOString(), durationSec: 20, triggers: ['motion' as const], sizeSub: 1, sizeMain: 1 };
function render(extra: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(LivePanel, { target, props: { camera: { id: 'cam2', name: 'cam2', webUiUrl: null }, latest: ev, pending: [], onplay: vi.fn(), proxyInfo: null, ...extra } });
  flushSync();
  return target;
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('LivePanel', () => {
  it('names a simulated camera, its model and streams', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: true, model: 'RLC-1224A', firmware: 'v3', simulator: 'cam-sim', streams: { main: { codec: 'h265', width: 4512, height: 2512, fps: 20 }, sub: { codec: 'h264', width: 896, height: 512, fps: 10 } } } }));
    render();
    expect(q('live-camera-kind')!.textContent).toBe('Simulated camera');
    expect(q('live-camera-model')!.textContent).toContain('RLC-1224A');
    expect(q('live-camera-streams')!.textContent).toContain('H.265 4512×2512 @20');
  });

  it('shows the latest event with how long ago, and plays it on click', () => {
    const onplay = vi.fn();
    render({ onplay });
    expect(q('live-latest-ago')!.textContent).toBe('12 minutes ago');
    q('live-latest')!.click();
    expect(onplay).toHaveBeenCalledWith(ev);
  });

  it('shows the offline banner with Retry', () => {
    liveUi.update((u) => ({ ...u, status: { id: 'cam2', online: false, error: 'camera_offline' } }));
    render();
    expect(q('offline-reason')!.textContent).toBe('The camera could not be reached.');
    expect(q('retry')).not.toBeNull();
    expect(get(liveUi).status?.online).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run web/src/components/LivePanel.svelte.test.ts`
Expected: FAIL (no component).

- [ ] **Step 3: Implement** (`LivePanel.svelte`)

Sections, top to bottom, each a small card with `--surface` and `--border` like the Settings cards:
1. **Camera:**
   - name (`live-camera-name`);
   - kind (`live-camera-kind`: `$liveUi.status?.simulator ? 'Simulated camera' : 'Camera'`);
   - `model · firmware` (`live-camera-model`);
   - online, or the offline banner (moved markup from `Live.svelte`, the `offline` block with `offline-reason` and `retry` calling `liveActions.retry()`);
   - `live-state` ("Live" / "Reconnecting…" / "Connecting…" from `$liveUi.playerState`);
   - the streams (`live-camera-streams`: `Main H.265 4512×2512 @20 · Sub H.264 896×512 @10`, omitting nulls);
   - when `proxyInfo?.webUrl`, a link "cam-proxy" to it.
2. **Latest event** (when `pending.length`, the newest pending instead, with a pulsing dot and "recording…"): the thumbnail (`thumbUrl`), time, `TRIGGER_LABELS` of its triggers, and `live-latest-ago` from `timeAgo(Date.parse(latest.start), Date.now())` (refreshed each 30 s). The whole card is a `<button data-testid="live-latest">` calling `onplay(latest)`.
3. **Controls:** the moved buttons from `Live.svelte`'s `.controls`, calling `liveActions.*`:
   - `mute-toggle`, `aria-pressed={!$liveUi.muted}`;
   - `quality-toggle` when `$liveUi.hevc`;
   - `snapshot`, disabled while `$liveUi.snapshotBusy`;
   - `fullscreen`;
   - `snapshot-error` under them when set.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/LivePanel.svelte web/src/components/LivePanel.svelte.test.ts
git commit -m "feat(video): the Live panel"
```

---

### Task 7: One Video page; App, router and e2e moved over

**Files:**
- Rename: `web/src/pages/Recordings.svelte` → `web/src/pages/Video.svelte` (`git mv`)
- Modify: `web/src/App.svelte`, `web/src/lib/router.ts` (+ test)
- Delete: `web/src/pages/Live.svelte`, `web/src/components/Timeline.svelte`, `web/src/components/Timeline.svelte.test.ts` (check first: `grep -rn "components/Timeline.svelte" web/src` must only list Live)
- Modify e2e: `live.spec.ts`, `live-keepalive.spec.ts`, `live-teardown.spec.ts`, `recordings.spec.ts` ('the Live page mini timeline opens a recording'), `shell.spec.ts`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces:
  - `Panel = 'live' | 'history' | 'downloads'`; `parseRoute('/app/live')` gives `{ page: 'video', panel: 'live' }` and `/app/recordings` gives `{ page: 'video', panel }`.
  - `NAV_ITEMS`: `live` → `{ page: 'video', panel: 'live', href: '/app/live' }`; `history` and `downloads` → page `video`.
  - `isActive` compares page and panel.

- [ ] **Step 1: Router tests first** (`router.test.ts`)

```ts
  it('routes Live and the recordings panels to one video page (spec 2026-09-28)', () => {
    expect(parseRoute('/app/live', '')).toMatchObject({ page: 'video', panel: 'live' });
    expect(parseRoute('/app/recordings', '?panel=downloads')).toMatchObject({ page: 'video', panel: 'downloads' });
    expect(parseRoute('/app/recordings', '?panel=events')).toMatchObject({ page: 'video', panel: 'history' });
    expect(parseRoute('/app/recordings', '')).toMatchObject({ page: 'video', panel: 'history' });
  });
```

Update the existing router tests' expectations: `page: 'live'` becomes `'video'` (and so on). The "marks exactly one item active" test for `/app/live` still expects `['live']`.

Run: `npx vitest run web/src/lib/router.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement the router**

`Page` gains `'video'`, and `live` and `recordings` are dropped. `PANELS = ['live', 'history', 'downloads']`. `/app/live` → panel live. `/app/recordings` → `panel` param (with `events` → history, and anything else → history). `NAV_ITEMS` hrefs are unchanged.

Run: `npx vitest run web/src/lib/router.test.ts`
Expected: PASS.

- [ ] **Step 3: The Video page**

`git mv web/src/pages/Recordings.svelte web/src/pages/Video.svelte`, then:
1. **Panels:** `TABS` becomes `[live, history, downloads]` with labels Live, History, Downloads. `panel` comes from the route.
2. **Title:** `<h1 data-testid="page-title">{panel === 'live' ? 'Live' : 'Recordings'}</h1>`. The day picker and "Updated" show on history and downloads only.
3. **HistoryView:** `<HistoryView … live={panel === 'live'} bind:glued liveBox={liveBoxSnippet} />`, with

```svelte
{#snippet liveBoxSnippet()}
  {#if liveWanted}<LiveBox cameraId={cam!} visible={visibleLive} audible={audibleLive} proxy={!!$cameras.find((x) => x.id === cam)?.proxy} />{/if}
{/snippet}
```

   The LiveBox must stay mounted while `liveWanted`, even when unglued. So StripPlayer renders the `live` snippet whenever it's given, and only *shows* it while glued. Adjust StripPlayer: `{#if liveSnippet}<div class="layer live" class:hidden={!glued}>{@render liveSnippet()}</div>{/if}`. That's the Task 4 markup with `class:hidden` instead of `{#if glued}`; re-run Task 4's tests.
4. **Live stream keep-alive inside the page:**

```ts
  // Leaving the live stream (unglued, or another panel) keeps it for the
  // keep-alive time; coming back within it shows it at once (Klaus).
  let liveWanted = $state(false);
  const liveKeep = createKeepAlive(() => (liveWanted = false));
  $effect(() => {
    const onLive = glued && panel === 'live' && pageVisible && tabVisible;
    if (onLive) {
      liveWanted = true;
      liveKeep.enter();
    } else if (liveWanted) liveKeep.leave($preferences?.liveKeepAlive ?? 60);
  });
  $effect(() => () => liveKeep.dispose());
```

   `pageVisible` and `tabVisible` come as props from App (see 5). Switching camera while not on live ends the stream at once: move the `liveCamera` effect from App here and set `liveWanted = false` on a camera change unless `onLive`. The same page stores `liveStreamHeld` (exported from `liveUi.ts` as a writable boolean) `= liveWanted`, for App.
5. **App** (`App.svelte`):
   - The Live host is replaced by a Video host.
   - `videoMounted` is true while `$route.page === 'video'`, or while `$liveStreamHeld` and the page is off screen.
   - Render `<div class="video-host" hidden={$route.page !== 'video'}><Video pageVisible={$route.page === 'video'} tabVisible={tabVisible} /></div>` when `videoMounted`.
   - The keyed block renders the other pages when `$route.page !== 'video'`.
   - The existing keep-alive countdown in App is removed; the Video page owns it (4). Unmount the host when `$route.page !== 'video' && !$liveStreamHeld`.
6. **Spacers:** the workspace becomes `grid-template-columns: 1fr minmax(0, var(--player-max-w)) 340px` with an empty `.spacer` first child, and `.spacer { background: var(--bg); }`. Below 1200 px: `grid-template-columns: minmax(0, var(--player-max-w))` with the spacer hidden (`display: none`).
7. **Live panel:** when `panel === 'live'`, the aside renders `LivePanel` with:
   - `latest`: the newest of today's events (`events.at(-1)` after sorting by start);
   - `pending={pendingToday}`;
   - `onplay={(e) => historyView?.jump(Date.parse(e.start), true)}`, which unglues through `jump`;
   - `proxyInfo`: fetched as ProxySwitch does (`/api/cameras/:id/proxy/info`), once per camera.
8. Delete `Live.svelte`, `Timeline.svelte` and its test.

- [ ] **Step 4: Move the e2e over**
- **`live.spec.ts`:** `/app/live` works as before (panel live). Test ids are unchanged. Where a test checks `page-title` 'Live' it still holds. The badge `live-badge` now sits in the info line.
- **`live-keepalive.spec.ts`:** "leaving Live" now means going to Settings, **or** clicking the History tab, **or** moving back on the strip. Keep every existing test (they leave by navigating to another page). Add one:

```ts
test('moving into playback keeps the live stream for the keep-alive; ⇥ shows it again at once', async ({ page }) => {
  await page.goto('/app/live');
  const video = page.getByTestId('live-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2)).toBe(true);
  let liveRequests = 0;
  page.on('request', (r) => { if (/\/api\/cameras\/[^/]+\/live/.test(r.url())) liveRequests++; });
  await page.getByTestId('back-10').click(); // playback
  await expect(page.getByTestId('live-badge')).toHaveCount(0);
  await page.getByTestId('strip-now').click(); // live again
  await expect(page.getByTestId('live-badge')).toHaveText('● LIVE');
  expect(liveRequests).toBe(0);
});
```

- **`live-teardown.spec.ts`:** unchanged URLs; it switches cameras on `/app/live` and must still pass.
- **`recordings.spec.ts`,** 'the Live page mini timeline opens a recording': rewrite it as "clicking the latest event on the Live panel plays it":

```ts
test('the Live panel’s latest event plays it', async ({ page }) => {
  await page.goto('/app/live');
  await page.getByTestId('live-latest').click();
  await expect(page.getByTestId('live-badge')).toHaveCount(0);
  await expect(page.getByTestId('source-badge')).toContainText(/SD 10 FPS|Stills|No recording/);
});
```

- **`shell.spec.ts`:** the Live case still expects `page-title` 'Live' at `/app/live`.
- **Add** a layout check:

```ts
test('the video stays in place between Live, History and Downloads', async ({ page }) => {
  await page.goto('/app/live');
  const box = async () => page.locator('.player .box').boundingBox();
  const a = await box();
  await page.getByTestId('panel-tab-history').click();
  const b = await box();
  await page.getByTestId('panel-tab-downloads').click();
  const c = await box();
  expect(b).toEqual(a);
  expect(c).toEqual(a);
});
```

- [ ] **Step 5: Run everything**

Run: `npm test && npm run build && npm run check && npx playwright test`
Expected: all pass. Where an existing e2e test fails only because of the moved layout (a selector scoped to the old Live page, or a heading), update the selector and ledger it. Where it fails on behaviour, it's a bug: debug it.

- [ ] **Step 6: Commit**

```bash
git add -A web/src e2e
git commit -m "feat(video): one page for Live, History and Downloads; Live is the strip's live end"
```

(`git add -A web/src e2e` stages the deletions. Check `git status` first.)

---

### Task 8: Docs

**Files:** `README.md`, `CHANGELOG.md`

- [ ] **Step 1:** CHANGELOG `## [Unreleased]`:

```markdown
- One video page: Live, History and Downloads share the video, the line
  under it and the strip; the menu switches the panel on the right. On Live
  the strip's playhead sits at now (the live stream); moving back plays the
  recording, ⇥ is live again. The Live panel shows the camera (simulated or
  not, model, streams), the latest event (click to play) and the live
  controls. Wide windows get spacers so the panel sits on the right.
- A 30-minute zoom.
- Leaving the live stream (playback or another page) keeps it for the
  keep-alive time, as before.
```

- [ ] **Step 2:** README: in Pages, "Live" becomes "Live (the video page's live panel)", and the Recordings bullet names the three panels. In the cam-proxy/strip bullets, mention the live end. In the API list, `status` gains `simulator` and `streams`.

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: the one video page"
```
