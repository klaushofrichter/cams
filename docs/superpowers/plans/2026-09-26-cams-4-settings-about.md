# cams Plan 4: Settings and About Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Settings page with four cards, an About page, and a LAN-only
"Camera web UI" link.

- **App preferences** are stored per user on the server: default camera,
  default live quality, default event filter and timeline zoom.
- **Detection and recording** covers recording on/off, motion sensitivity, and
  per-type AI recording and sensitivity.
- **Image and lights** covers day/night, IR lights, spotlight and the on-screen
  name/time overlay.
- **Device and maintenance** shows model, firmware, storage and the camera's
  certificate, and offers a reboot with confirmation.
- **About** shows version, build date, repo, supported cameras, and credits and
  licences.
- **The "Camera web UI" link** sits in the top bar and on the Device card. It
  only works on the home network, and says so.

**Architecture:**
- **Mapping.** `server/reolink/settings.ts` translates between typed cams
  settings and the Reolink commands, using the shapes measured below. It is
  pure functions, unit-tested against the real replies.
- **Routes.** New routes read settings. A write sends only the changed fields,
  one command per field group. Each write is **re-read** and reported **per
  field** (spec §3, §6), because the firmware answers `200` even when a write
  does nothing.
- **Preferences** live in one JSON file on a small persistent volume, keyed by
  email and written atomically.
- **Mock camera.** It gains every Get/Set command with in-memory state and a
  switch for injected failures, so e2e can show both the success and the error
  state.

**Tech Stack:** as in Plans 1–3. No new dependencies. The camera certificate
is read with `node:tls`.

**Spec:** `docs/superpowers/specs/2026-09-25-cams-design.md`:
- §3 Settings: app preferences and camera settings
- §5 Settings page and About page
- §6 per-field write failures
- §7 settings tests and the mock's settings commands

**Decision carried in:** the camera web UI link is **LAN-only**. Klaus decided
this on 2026-09-26, and `docs/reolink-api.md` explains why.

## Camera facts this plan relies on (measured 2026-09-26, RLC-1224A, fw v3.2.0.6011_2607012059)

All Set commands below were verified on the real camera by writing back the
current value. Each answered `code 0, rspCode 200`, and a re-read showed no
change. Invalid values are rejected and leave the old value in place:
- `SetMdAlarm` with `sensDef: 99` returns `rspCode -56`.
- `SetIsp` with `dayNight: "Purple"` returns `rspCode -67`.

| Setting | Read | Write (partial params are accepted) | Values |
|---|---|---|---|
| Recording on/off | `GetRecV20 {channel:0}` → `Rec.enable` | `SetRecV20 {Rec:{enable}}` | 0/1 |
| Record on AI type | `Rec.schedule.table.AI_PEOPLE / AI_VEHICLE / AI_DOG_CAT` (168 chars, one per hour of the week) | `SetRecV20 {Rec:{schedule:{channel:0,table:{AI_PEOPLE:"1"×168}}}}` | all `1` = on, all `0` = off; anything else = "custom" |
| Motion recording | `Rec.schedule.table.MD` | as above, key `MD` | as above |
| Motion sensitivity | `GetMdAlarm {channel:0}` → `MdAlarm.newSens.sensDef` (when `useNewSens: 1`) | `SetMdAlarm {MdAlarm:{channel:0,useNewSens:1,newSens:{sensDef}}}` | `sensDef` 1–50, **lower = more sensitive**. Shown as `51 − sensDef` (1–50, higher = more sensitive), as `reolink_aio` does. |
| AI sensitivity | `GetAiAlarm {channel:0,ai_type}` → `AiAlarm.sensitivity` | `SetAiAlarm {AiAlarm:{channel:0,ai_type,sensitivity}}` | 0–100; `ai_type` ∈ `people`, `vehicle`, `dog_cat` |
| Day/night | `GetIsp {channel:0}` → `Isp.dayNight` | `SetIsp {Isp:{channel:0,dayNight}}` | `Auto`, `Color`, `Black&White` |
| IR lights | `GetIrLights {channel:0}` → `IrLights.state` | `SetIrLights {IrLights:{channel:0,state}}` | `Auto`, `Off` |
| Spotlight | `GetWhiteLed {channel:0}` → `WhiteLed.mode`, `WhiteLed.bright` | `SetWhiteLed {WhiteLed:{channel:0,mode,bright}}` | mode 0 off, 1 auto (on motion at night), 2 on at night, 3 schedule; bright 0–100 |
| OSD | `GetOsd {channel:0}` → `Osd.osdChannel {enable,name,pos}`, `Osd.osdTime {enable,pos}` | `SetOsd {Osd:{channel:0,osdChannel:{…},osdTime:{…}}}` | pos ∈ `Upper Left`, `Top Center`, `Upper Right`, `Lower Left`, `Bottom Center`, `Lower Right`; name max 31 chars |
| Device | `GetDevInfo` → `DevInfo {model, firmVer, hardVer, name, serial}` | — | |
| Storage | `GetHddInfo` → `HddInfo[0] {capacity, size, mount, format}` | — | MB. `size` is **free** space: it shrinks as recordings grow. Used = `capacity − size`. |
| Certificate | TLS handshake to the camera (`getPeerCertificate()`: `subject.CN`, `issuer.O`, `valid_to`) | — | `GetCertificateInfo` has no subject or expiry |
| Reboot | — | `Reboot {}` | Only after a confirmation in the UI. The camera is offline for about 1 minute. |

The real camera currently has `MD`, `AI_PEOPLE`, `AI_VEHICLE` and `AI_DOG_CAT`
all fully on (168 × `1`), and `sensDef 10`, which is shown as motion
sensitivity 41. AI sensitivity for people is 60, `dayNight` is `Auto`,
`IrLights` is `Auto`, `WhiteLed mode 1 bright 100`, and the OSD shows name
"Den" at Lower Right and time at Top Center.

## Global Constraints

- Everything in the Global Constraints of Plans 1–3 still applies:
  - Node 26, auth on every `/api` route, no secrets in logs or URLs;
  - camera tokens only in camera URLs;
  - the camera's 2 API gate slots;
  - the error codes `camera_offline` (503), `camera_auth_failed` (503) and
    `camera_error` (502).
- **Routes.** All sit under `/api` auth and the same-origin check:
  - `GET /api/cameras/:id/settings` → `{ detection: DetectionSettings, image: ImageSettings }`
  - `PUT /api/cameras/:id/settings/detection`, body `Partial<DetectionSettings>` (deep partial for `ai`) → `SaveResult`
  - `PUT /api/cameras/:id/settings/image`, body `Partial<ImageSettings>` (deep partial for `spotlight` and `osd`) → `SaveResult`
  - `GET /api/cameras/:id/device` → `DeviceInfo`
  - `POST /api/cameras/:id/reboot`, body `{"confirm":"reboot"}` → `{ ok: true }`. Without the exact body it returns `400 {"error":"bad_request"}`.
  - `GET /api/preferences` → `Preferences`. `PUT /api/preferences`, body `Partial<Preferences>` → `Preferences`.
  - `GET /api/cameras` → `[{ id, name, webUiUrl }]`. `webUiUrl` is `https://<host>/`, built from the registry `host` without any port.
- **`SaveResult`** = `{ fields: Record<string, { ok: boolean; error?: string }>; settings: DetectionSettings | ImageSettings }`.
  - `settings` is the **re-read** state.
  - A field counts as ok only if its command succeeded **and** the re-read value equals the requested value. Otherwise `error` is `"camera_rejected"` (the command failed) or `"not_applied"` (it succeeded but the re-read differs).
  - HTTP status: `200` if every field is ok; `207` if some failed; `400 {"error":"bad_request","details":[…]}` for invalid input, **before any camera call**.
  - Field names: `recording`, `motionRecording`, `motionSensitivity`, `ai.person.record`, `ai.person.sensitivity` (same for `vehicle`, `pet`), `dayNight`, `irLights`, `spotlight`, `osd`.
- **Validation** is exactly the camera's ranges:
  - motion sensitivity: integer 1–50
  - AI sensitivity: integer 0–100
  - spotlight brightness: integer 0–100
  - spotlight mode: `off`, `auto`, `night`, `schedule`
  - dayNight: `auto`, `color`, `blackwhite`
  - irLights: `auto`, `off`
  - OSD positions: the six strings above
  - OSD name: 1–31 characters, no control characters

  Unknown keys give 400.
- **The camera API gate.** Settings reads and writes go through
  `client.command()`, so they share the 2-slot API gate and the token and
  re-login handling. Writes go out one command at a time, in field order.
- **Preferences.**
  - Stored in `PREFS_FILE` (default `join(os.tmpdir(), 'cams-preferences.json')`); in the cluster, `/var/lib/cams/preferences.json` on the PVC `cams-data`.
  - Keyed by the lower-cased email.
  - Written to a temp file and renamed.
  - Defaults: `{ defaultCamera: null, liveQuality: 'sub', eventFilter: 'all', timelineZoom: 24 }`.
- **The "Camera web UI" link.**
  - `target="_blank" rel="noopener noreferrer"`, with `title="Opens the camera's own web page. Works on the home network only."`
  - On the Device card, a visible note: "Works on the home network only. The camera's page isn't reachable from the internet."
  - Test ids: `camera-webui-link` (top bar), `device-webui-link` (card).
- **Test ids used by e2e:**
  - Cards: `settings-card-{prefs|detection|image|device}`, and inside each card `save-{prefs|detection|image}`.
  - Save state: `save-state` with `data-state` = `idle|saving|saved|partial|error`.
  - Fields: `field-error-<field>` next to a failed field.
  - Detection: `recording-toggle`, `motion-recording-toggle`, `motion-sensitivity`, `ai-{person|vehicle|pet}-record`, `ai-{person|vehicle|pet}-sensitivity`.
  - Image: `daynight-select`, `ir-select`, `spotlight-mode`, `spotlight-brightness`, `osd-name`, `osd-name-toggle`, `osd-time-toggle`, `osd-name-pos`, `osd-time-pos`.
  - Device: `device-model`, `device-firmware`, `device-storage`, `device-cert`, `reboot-button`, `reboot-confirm`, `reboot-cancel`.
  - Preferences: `pref-camera`, `pref-quality`, `pref-filter`, `pref-zoom`.
  - About: `about-version`, `about-build`, `about-cameras`, `about-licences`.

## Review Focus

1. **A write that "succeeds" but changes nothing** (firmware `rspCode 200` with
   no effect, as seen with ImportCertificate) must show as a failed field, not
   as saved. This is pinned in Task 2: the mock's `ignoreWrites` option.
2. **Invalid input must never reach the camera.** Out-of-range sensitivity, an
   unknown position string, a 40-character name or extra keys must return 400
   before any camera call. This is pinned in Task 3, which asserts the mock
   received no Set.
3. **A partial failure must not hide the fields that did save.** One failing
   command in a card save (e.g. `SetWhiteLed` rejected) must leave the other
   fields' results intact and the re-read state current. This is pinned in
   Tasks 3 and 6.
4. **Reboot must be impossible by accident.** It needs the exact confirm body on
   the server and an explicit second click in the UI. Pinned in Tasks 3 and 6.
5. **A schedule the user customised in the camera's own UI** (some hours on,
   some off) must show as "custom", and saving an unrelated field must not
   overwrite it. Only an explicit toggle of that type writes the table. Pinned
   in Tasks 1 and 3.

---

### Task 1: Settings mapping (pure)

**Files:**
- Create: `server/reolink/settings.ts`
- Test: `test/settingsMapping.test.ts`

**Interfaces:**
- **Produces** these types:
  - `Schedule = 'on' | 'off' | 'custom'`
  - `AiKind = 'person' | 'vehicle' | 'pet'`
  - `DetectionSettings = { recording: boolean; motionRecording: Schedule; motionSensitivity: number; ai: Record<AiKind, { record: Schedule; sensitivity: number }> }`
  - `OsdPosition` (the six strings)
  - `SpotlightMode = 'off' | 'auto' | 'night' | 'schedule'`
  - `ImageSettings = { dayNight: 'auto' | 'color' | 'blackwhite'; irLights: 'auto' | 'off'; spotlight: { mode: SpotlightMode; brightness: number }; osd: { showName: boolean; name: string; namePosition: OsdPosition; showTime: boolean; timePosition: OsdPosition } }`
  - `DetectionPatch`, `ImagePatch` (deep partials in which each schedule may only be `'on' | 'off'`)
  - `SettingsCommand = { field: string; cmd: string; param: object }`
- **Produces** these functions:
  - `detectionFrom(raw: { rec: unknown; md: unknown; ai: Record<AiKind, unknown> }): DetectionSettings`
  - `imageFrom(raw: { isp: unknown; ir: unknown; wl: unknown; osd: unknown }): ImageSettings`
  - `validateDetectionPatch(body: unknown): { ok: true; patch: DetectionPatch } | { ok: false; details: string[] }`
  - `validateImagePatch(body: unknown)`, with the same shape
  - `detectionCommands(patch: DetectionPatch): SettingsCommand[]`
  - `imageCommands(patch: ImagePatch, current: ImageSettings): SettingsCommand[]`. The OSD needs the unchanged half from `current`.
  - `patchApplied(field: string, patch: DetectionPatch | ImagePatch, reread: DetectionSettings | ImageSettings): boolean`
  - `AI_TYPE: Record<AiKind, 'people' | 'vehicle' | 'dog_cat'>` and `SCHEDULE_KEY: Record<AiKind, 'AI_PEOPLE' | 'AI_VEHICLE' | 'AI_DOG_CAT'>`

- [ ] **Step 1: Failing test `test/settingsMapping.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  detectionCommands, detectionFrom, imageCommands, imageFrom, patchApplied,
  validateDetectionPatch, validateImagePatch, type ImageSettings,
} from '../server/reolink/settings';

const ALL = '1'.repeat(168);
const NONE = '0'.repeat(168);
// Shapes as returned by the real RLC-1224A (fw v3.2.0.6011), trimmed.
const REAL = {
  rec: { Rec: { enable: 1, schedule: { channel: 0, table: { MD: ALL, AI_PEOPLE: ALL, AI_VEHICLE: ALL, AI_DOG_CAT: ALL, TIMING: NONE } } } },
  md: { MdAlarm: { channel: 0, useNewSens: 1, newSens: { sensDef: 10 } } },
  ai: {
    person: { AiAlarm: { ai_type: 'people', sensitivity: 60 } },
    vehicle: { AiAlarm: { ai_type: 'vehicle', sensitivity: 50 } },
    pet: { AiAlarm: { ai_type: 'dog_cat', sensitivity: 40 } },
  },
  isp: { Isp: { channel: 0, dayNight: 'Auto', antiFlicker: '60HZ' } },
  ir: { IrLights: { state: 'Auto' } },
  wl: { WhiteLed: { channel: 0, mode: 1, bright: 100, state: 0 } },
  osd: { Osd: { channel: 0, osdChannel: { enable: 1, name: 'Den', pos: 'Lower Right' }, osdTime: { enable: 1, pos: 'Top Center' } } },
};

describe('reading settings', () => {
  it('maps the real camera replies', () => {
    expect(detectionFrom(REAL)).toEqual({
      recording: true,
      motionRecording: 'on',
      motionSensitivity: 41, // 51 - sensDef 10: higher = more sensitive
      ai: {
        person: { record: 'on', sensitivity: 60 },
        vehicle: { record: 'on', sensitivity: 50 },
        pet: { record: 'on', sensitivity: 40 },
      },
    });
    expect(imageFrom(REAL)).toEqual({
      dayNight: 'auto',
      irLights: 'auto',
      spotlight: { mode: 'auto', brightness: 100 },
      osd: { showName: true, name: 'Den', namePosition: 'Lower Right', showTime: true, timePosition: 'Top Center' },
    });
  });

  // Review focus 5.
  it('reports a partly-on schedule as custom', () => {
    const custom = '1'.repeat(84) + '0'.repeat(84);
    const d = detectionFrom({ ...REAL, rec: { Rec: { enable: 0, schedule: { table: { MD: custom, AI_PEOPLE: NONE, AI_VEHICLE: ALL, AI_DOG_CAT: ALL } } } } });
    expect(d.recording).toBe(false);
    expect(d.motionRecording).toBe('custom');
    expect(d.ai.person.record).toBe('off');
  });

  it('maps every day/night, spotlight and IR value', () => {
    const img = (isp: string, mode: number, ir: string) =>
      imageFrom({ ...REAL, isp: { Isp: { dayNight: isp } }, wl: { WhiteLed: { mode, bright: 5 } }, ir: { IrLights: { state: ir } } });
    expect(img('Color', 0, 'Off')).toMatchObject({ dayNight: 'color', irLights: 'off', spotlight: { mode: 'off', brightness: 5 } });
    expect(img('Black&White', 2, 'Auto')).toMatchObject({ dayNight: 'blackwhite', spotlight: { mode: 'night' } });
    expect(img('Auto', 3, 'Auto').spotlight.mode).toBe('schedule');
  });
});

describe('validating patches', () => {
  it('accepts valid detection and image patches', () => {
    expect(validateDetectionPatch({ recording: false, motionSensitivity: 50, ai: { pet: { sensitivity: 0, record: 'off' } } })).toEqual({
      ok: true,
      patch: { recording: false, motionSensitivity: 50, ai: { pet: { sensitivity: 0, record: 'off' } } },
    });
    expect(validateImagePatch({ spotlight: { brightness: 0 }, osd: { name: 'Front door' } }).ok).toBe(true);
  });

  // Review focus 2.
  it.each([
    [{ motionSensitivity: 0 }],
    [{ motionSensitivity: 51 }],
    [{ motionSensitivity: 10.5 }],
    [{ ai: { person: { sensitivity: 101 } } }],
    [{ ai: { cat: { sensitivity: 5 } } }],
    [{ motionRecording: 'custom' }],
    [{ recording: 'yes' }],
    [{ surprise: 1 }],
    ['not an object'],
  ])('rejects detection patch %j', (body) => {
    expect(validateDetectionPatch(body).ok).toBe(false);
  });

  it.each([
    [{ dayNight: 'Purple' }],
    [{ irLights: 'on' }],
    [{ spotlight: { mode: 'disco' } }],
    [{ spotlight: { brightness: 101 } }],
    [{ osd: { name: '' } }],
    [{ osd: { name: 'x'.repeat(32) } }],
    [{ osd: { name: 'bad\nname' } }],
    [{ osd: { namePosition: 'Middle' } }],
    [{ osd: { extra: true } }],
  ])('rejects image patch %j', (body) => {
    expect(validateImagePatch(body).ok).toBe(false);
  });
});

describe('building commands', () => {
  it('writes only what changed, one command per field, in a stable order', () => {
    expect(detectionCommands({ recording: false, motionSensitivity: 50, ai: { vehicle: { record: 'off', sensitivity: 70 } } })).toEqual([
      { field: 'recording', cmd: 'SetRecV20', param: { Rec: { enable: 0 } } },
      { field: 'motionSensitivity', cmd: 'SetMdAlarm', param: { MdAlarm: { channel: 0, useNewSens: 1, newSens: { sensDef: 1 } } } },
      { field: 'ai.vehicle.record', cmd: 'SetRecV20', param: { Rec: { schedule: { channel: 0, table: { AI_VEHICLE: NONE } } } } },
      { field: 'ai.vehicle.sensitivity', cmd: 'SetAiAlarm', param: { AiAlarm: { channel: 0, ai_type: 'vehicle', sensitivity: 70 } } },
    ]);
    expect(detectionCommands({ motionRecording: 'on' })).toEqual([
      { field: 'motionRecording', cmd: 'SetRecV20', param: { Rec: { schedule: { channel: 0, table: { MD: ALL } } } } },
    ]);
  });

  it('keeps the unchanged OSD half when only one part changes', () => {
    const current = imageFrom(REAL) as ImageSettings;
    expect(imageCommands({ osd: { name: 'Porch' }, dayNight: 'color', spotlight: { mode: 'off' } }, current)).toEqual([
      { field: 'dayNight', cmd: 'SetIsp', param: { Isp: { channel: 0, dayNight: 'Color' } } },
      { field: 'spotlight', cmd: 'SetWhiteLed', param: { WhiteLed: { channel: 0, mode: 0, bright: 100 } } },
      {
        field: 'osd',
        cmd: 'SetOsd',
        param: { Osd: { channel: 0, osdChannel: { enable: 1, name: 'Porch', pos: 'Lower Right' }, osdTime: { enable: 1, pos: 'Top Center' } } },
      },
    ]);
  });

  it('checks each field against the re-read state', () => {
    const reread = detectionFrom(REAL);
    expect(patchApplied('motionSensitivity', { motionSensitivity: 41 }, reread)).toBe(true);
    expect(patchApplied('motionSensitivity', { motionSensitivity: 20 }, reread)).toBe(false);
    expect(patchApplied('ai.person.record', { ai: { person: { record: 'on' } } }, reread)).toBe(true);
    const img = imageFrom(REAL);
    expect(patchApplied('osd', { osd: { name: 'Den' } }, img)).toBe(true);
    expect(patchApplied('spotlight', { spotlight: { mode: 'off' } }, img)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/settingsMapping.test.ts`
Expected: FAIL, because the module does not exist yet.

- [ ] **Step 3: Implement `server/reolink/settings.ts`**

```ts
// Typed cams settings <-> Reolink commands. Shapes measured on RLC-1224A
// firmware v3.2.0.6011 (see docs/reolink-api.md and the Plan 4 camera facts).
// Pure: no I/O, so every mapping is unit-tested against real replies.

export type Schedule = 'on' | 'off' | 'custom';
export type AiKind = 'person' | 'vehicle' | 'pet';
export const AI_KINDS: AiKind[] = ['person', 'vehicle', 'pet'];
export const AI_TYPE: Record<AiKind, 'people' | 'vehicle' | 'dog_cat'> = { person: 'people', vehicle: 'vehicle', pet: 'dog_cat' };
export const SCHEDULE_KEY: Record<AiKind, 'AI_PEOPLE' | 'AI_VEHICLE' | 'AI_DOG_CAT'> = {
  person: 'AI_PEOPLE',
  vehicle: 'AI_VEHICLE',
  pet: 'AI_DOG_CAT',
};

export interface DetectionSettings {
  recording: boolean;
  motionRecording: Schedule;
  motionSensitivity: number; // 1–50, higher = more sensitive (51 − sensDef)
  ai: Record<AiKind, { record: Schedule; sensitivity: number }>;
}

export const OSD_POSITIONS = ['Upper Left', 'Top Center', 'Upper Right', 'Lower Left', 'Bottom Center', 'Lower Right'] as const;
export type OsdPosition = (typeof OSD_POSITIONS)[number];
export type SpotlightMode = 'off' | 'auto' | 'night' | 'schedule';
const SPOTLIGHT_MODES: SpotlightMode[] = ['off', 'auto', 'night', 'schedule']; // index = WhiteLed.mode

export interface ImageSettings {
  dayNight: 'auto' | 'color' | 'blackwhite';
  irLights: 'auto' | 'off';
  spotlight: { mode: SpotlightMode; brightness: number };
  osd: { showName: boolean; name: string; namePosition: OsdPosition; showTime: boolean; timePosition: OsdPosition };
}

type Toggle = 'on' | 'off';
export interface DetectionPatch {
  recording?: boolean;
  motionRecording?: Toggle;
  motionSensitivity?: number;
  ai?: Partial<Record<AiKind, { record?: Toggle; sensitivity?: number }>>;
}
export interface ImagePatch {
  dayNight?: ImageSettings['dayNight'];
  irLights?: ImageSettings['irLights'];
  spotlight?: Partial<ImageSettings['spotlight']>;
  osd?: Partial<ImageSettings['osd']>;
}

export interface SettingsCommand {
  field: string;
  cmd: string;
  param: object;
}

const DAYNIGHT: Record<ImageSettings['dayNight'], string> = { auto: 'Auto', color: 'Color', blackwhite: 'Black&White' };
const IR: Record<ImageSettings['irLights'], string> = { auto: 'Auto', off: 'Off' };
const HOURS = 168;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function scheduleOf(table: string | undefined): Schedule {
  if (!table) return 'off';
  if (/^1+$/.test(table)) return 'on';
  if (/^0+$/.test(table)) return 'off';
  return 'custom';
}

function reverse<T extends string>(map: Record<T, string>, value: unknown, fallback: T): T {
  const hit = (Object.keys(map) as T[]).find((k) => map[k] === value);
  return hit ?? fallback;
}

export function detectionFrom(raw: { rec: unknown; md: unknown; ai: Record<AiKind, unknown> }): DetectionSettings {
  const rec = obj(obj(raw.rec).Rec);
  const table = obj(obj(rec.schedule).table) as Record<string, string>;
  const md = obj(obj(raw.md).MdAlarm);
  const sensDef = num(obj(md.newSens).sensDef, 10);
  const ai = {} as DetectionSettings['ai'];
  for (const kind of AI_KINDS) {
    ai[kind] = { record: scheduleOf(table[SCHEDULE_KEY[kind]]), sensitivity: num(obj(obj(raw.ai[kind]).AiAlarm).sensitivity) };
  }
  return { recording: num(rec.enable) === 1, motionRecording: scheduleOf(table.MD), motionSensitivity: 51 - sensDef, ai };
}

export function imageFrom(raw: { isp: unknown; ir: unknown; wl: unknown; osd: unknown }): ImageSettings {
  const isp = obj(obj(raw.isp).Isp);
  const wl = obj(obj(raw.wl).WhiteLed);
  const osd = obj(obj(raw.osd).Osd);
  const ch = obj(osd.osdChannel);
  const time = obj(osd.osdTime);
  const pos = (p: unknown): OsdPosition => ((OSD_POSITIONS as readonly string[]).includes(p as string) ? (p as OsdPosition) : 'Upper Left');
  return {
    dayNight: reverse(DAYNIGHT, isp.dayNight, 'auto'),
    irLights: reverse(IR, obj(obj(raw.ir).IrLights).state, 'auto'),
    spotlight: { mode: SPOTLIGHT_MODES[num(wl.mode)] ?? 'off', brightness: num(wl.bright) },
    osd: {
      showName: num(ch.enable) === 1,
      name: typeof ch.name === 'string' ? ch.name : '',
      namePosition: pos(ch.pos),
      showTime: num(time.enable) === 1,
      timePosition: pos(time.pos),
    },
  };
}

// --- validation: exactly the camera's ranges; unknown keys are errors ---

type Check = { ok: true } | { ok: false; details: string[] };
function onlyKeys(o: Obj, allowed: string[], path: string, details: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) details.push(`${path}${k}: unknown field`);
}
const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isObj = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateDetectionPatch(body: unknown): { ok: true; patch: DetectionPatch } | { ok: false; details: string[] } {
  if (!isObj(body)) return { ok: false, details: ['body must be an object'] };
  const b = body as Obj;
  const details: string[] = [];
  onlyKeys(b, ['recording', 'motionRecording', 'motionSensitivity', 'ai'], '', details);
  if ('recording' in b && typeof b.recording !== 'boolean') details.push('recording: must be true or false');
  if ('motionRecording' in b && b.motionRecording !== 'on' && b.motionRecording !== 'off') details.push('motionRecording: must be "on" or "off"');
  if ('motionSensitivity' in b && !isInt(b.motionSensitivity, 1, 50)) details.push('motionSensitivity: integer 1–50');
  if ('ai' in b) {
    if (!isObj(b.ai)) details.push('ai: must be an object');
    else {
      const ai = b.ai as Obj;
      onlyKeys(ai, AI_KINDS, 'ai.', details);
      for (const kind of AI_KINDS) {
        if (!(kind in ai)) continue;
        if (!isObj(ai[kind])) {
          details.push(`ai.${kind}: must be an object`);
          continue;
        }
        const k = ai[kind] as Obj;
        onlyKeys(k, ['record', 'sensitivity'], `ai.${kind}.`, details);
        if ('record' in k && k.record !== 'on' && k.record !== 'off') details.push(`ai.${kind}.record: must be "on" or "off"`);
        if ('sensitivity' in k && !isInt(k.sensitivity, 0, 100)) details.push(`ai.${kind}.sensitivity: integer 0–100`);
      }
    }
  }
  return details.length ? { ok: false, details } : { ok: true, patch: b as DetectionPatch };
}

export function validateImagePatch(body: unknown): { ok: true; patch: ImagePatch } | { ok: false; details: string[] } {
  if (!isObj(body)) return { ok: false, details: ['body must be an object'] };
  const b = body as Obj;
  const details: string[] = [];
  onlyKeys(b, ['dayNight', 'irLights', 'spotlight', 'osd'], '', details);
  if ('dayNight' in b && !(b.dayNight as string in DAYNIGHT)) details.push('dayNight: auto, color or blackwhite');
  if ('irLights' in b && !(b.irLights as string in IR)) details.push('irLights: auto or off');
  if ('spotlight' in b) {
    if (!isObj(b.spotlight)) details.push('spotlight: must be an object');
    else {
      const s = b.spotlight as Obj;
      onlyKeys(s, ['mode', 'brightness'], 'spotlight.', details);
      if ('mode' in s && !SPOTLIGHT_MODES.includes(s.mode as SpotlightMode)) details.push('spotlight.mode: off, auto, night or schedule');
      if ('brightness' in s && !isInt(s.brightness, 0, 100)) details.push('spotlight.brightness: integer 0–100');
    }
  }
  if ('osd' in b) {
    if (!isObj(b.osd)) details.push('osd: must be an object');
    else {
      const o = b.osd as Obj;
      onlyKeys(o, ['showName', 'name', 'namePosition', 'showTime', 'timePosition'], 'osd.', details);
      for (const k of ['showName', 'showTime']) if (k in o && typeof o[k] !== 'boolean') details.push(`osd.${k}: must be true or false`);
      if ('name' in o && (typeof o.name !== 'string' || o.name.length < 1 || o.name.length > 31 || /[\u0000-\u001f\u007f]/.test(o.name))) {
        details.push('osd.name: 1–31 characters, no control characters');
      }
      for (const k of ['namePosition', 'timePosition']) {
        if (k in o && !(OSD_POSITIONS as readonly string[]).includes(o[k] as string)) details.push(`osd.${k}: one of ${OSD_POSITIONS.join(', ')}`);
      }
    }
  }
  return details.length ? { ok: false, details } : { ok: true, patch: b as ImagePatch };
}

// --- commands: only what changed, in a stable order ---

const table = (key: string, t: Toggle) => ({ Rec: { schedule: { channel: 0, table: { [key]: (t === 'on' ? '1' : '0').repeat(HOURS) } } } });

export function detectionCommands(p: DetectionPatch): SettingsCommand[] {
  const out: SettingsCommand[] = [];
  if (p.recording !== undefined) out.push({ field: 'recording', cmd: 'SetRecV20', param: { Rec: { enable: p.recording ? 1 : 0 } } });
  if (p.motionRecording) out.push({ field: 'motionRecording', cmd: 'SetRecV20', param: table('MD', p.motionRecording) });
  if (p.motionSensitivity !== undefined) {
    out.push({
      field: 'motionSensitivity',
      cmd: 'SetMdAlarm',
      param: { MdAlarm: { channel: 0, useNewSens: 1, newSens: { sensDef: 51 - p.motionSensitivity } } },
    });
  }
  for (const kind of AI_KINDS) {
    const a = p.ai?.[kind];
    if (!a) continue;
    if (a.record) out.push({ field: `ai.${kind}.record`, cmd: 'SetRecV20', param: table(SCHEDULE_KEY[kind], a.record) });
    if (a.sensitivity !== undefined) {
      out.push({
        field: `ai.${kind}.sensitivity`,
        cmd: 'SetAiAlarm',
        param: { AiAlarm: { channel: 0, ai_type: AI_TYPE[kind], sensitivity: a.sensitivity } },
      });
    }
  }
  return out;
}

export function imageCommands(p: ImagePatch, current: ImageSettings): SettingsCommand[] {
  const out: SettingsCommand[] = [];
  if (p.dayNight) out.push({ field: 'dayNight', cmd: 'SetIsp', param: { Isp: { channel: 0, dayNight: DAYNIGHT[p.dayNight] } } });
  if (p.irLights) out.push({ field: 'irLights', cmd: 'SetIrLights', param: { IrLights: { channel: 0, state: IR[p.irLights] } } });
  if (p.spotlight) {
    const s = { ...current.spotlight, ...p.spotlight };
    out.push({ field: 'spotlight', cmd: 'SetWhiteLed', param: { WhiteLed: { channel: 0, mode: SPOTLIGHT_MODES.indexOf(s.mode), bright: s.brightness } } });
  }
  if (p.osd) {
    const o = { ...current.osd, ...p.osd };
    out.push({
      field: 'osd',
      cmd: 'SetOsd',
      param: {
        Osd: {
          channel: 0,
          osdChannel: { enable: o.showName ? 1 : 0, name: o.name, pos: o.namePosition },
          osdTime: { enable: o.showTime ? 1 : 0, pos: o.timePosition },
        },
      },
    });
  }
  return out;
}

// A field counts as saved only if the re-read camera state shows the value
// asked for: the firmware answers rspCode 200 even for writes it ignores.
export function patchApplied(field: string, patch: DetectionPatch | ImagePatch, reread: DetectionSettings | ImageSettings): boolean {
  const want = field.split('.').reduce<unknown>((o, k) => obj(o)[k], patch);
  const got = field.split('.').reduce<unknown>((o, k) => obj(o)[k], reread);
  if (isObj(want)) return Object.entries(want as Obj).every(([k, v]) => obj(got)[k] === v);
  return want === got;
}
```

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run test/settingsMapping.test.ts` (must be green), then the full `npx vitest run` and `npm run build`.

```bash
git add server/reolink/settings.ts test/settingsMapping.test.ts
git commit -m "feat: typed camera settings mapped to Reolink commands (measured shapes)"
```

---

### Task 2: Mock camera settings commands

**Files:**
- Modify: `test/mock-camera/server.ts`
- Test: `test/mockCamera.test.ts` (extend)

**Interfaces:**
- **Consumes:** the mock's existing POST handler and `valid(req)`.
- **Produces:**
  - `MockCameraOptions.settingsFailures?: string[]`: Set commands that answer `{code:1, error:{rspCode:-67}}`, e.g. `['SetWhiteLed']`.
  - `MockCameraOptions.ignoreWrites?: string[]`: Set commands that answer `rspCode 200` but change nothing.
  - `MockState.settings`: the in-memory camera state, with the same shapes as the real Get replies.
  - `MockState.setCalls: string[]`: the cmd names of every Set received.
  - `MockState.reboots: number`.
  - The mock serves these Gets: `GetRecV20`, `GetMdAlarm`, `GetAiAlarm` (per `ai_type`), `GetIsp`, `GetIrLights`, `GetWhiteLed`, `GetOsd`, `GetHddInfo`.
  - It serves the matching Sets, which merge partial params the way the camera does. `Reboot` makes the mock answer `offline` (503-like socket drop) for `rebootMs` (default 50 ms). The existing `GetDevInfo` is kept.
  - The initial state is the real camera's values listed in "Camera facts".

- [ ] **Step 1: Failing tests (append to `test/mockCamera.test.ts`)**

```ts
describe('mock camera settings', () => {
  async function tok(app: Parameters<typeof request>[0]) {
    return (await login(app)).body[0].value.Token.name as string;
  }
  const cmd = (app: Parameters<typeof request>[0], t: string, name: string, param: object) =>
    request(app).post(`/cgi-bin/api.cgi?cmd=${name}&token=${t}`).send([{ cmd: name, action: 0, param }]);

  it('reads the real camera defaults and merges partial writes', async () => {
    const { app, state } = createMockCamera(creds);
    const t = await tok(app);
    expect((await cmd(app, t, 'GetMdAlarm', { channel: 0 })).body[0].value.MdAlarm.newSens.sensDef).toBe(10);
    expect((await cmd(app, t, 'SetOsd', { Osd: { channel: 0, osdChannel: { enable: 1, name: 'Porch', pos: 'Lower Right' } } })).body[0].code).toBe(0);
    const osd = (await cmd(app, t, 'GetOsd', { channel: 0 })).body[0].value.Osd;
    expect(osd.osdChannel.name).toBe('Porch');
    expect(osd.osdTime).toEqual({ enable: 1, pos: 'Top Center' }); // untouched half kept
    const ai = (await cmd(app, t, 'GetAiAlarm', { channel: 0, ai_type: 'vehicle' })).body[0].value.AiAlarm;
    expect(ai.ai_type).toBe('vehicle');
    expect(state.setCalls).toEqual(['SetOsd']);
  });

  it('rejects out-of-range values like the firmware and keeps the old value', async () => {
    const { app } = createMockCamera(creds);
    const t = await tok(app);
    const bad = await cmd(app, t, 'SetMdAlarm', { MdAlarm: { channel: 0, useNewSens: 1, newSens: { sensDef: 99 } } });
    expect(bad.body[0]).toMatchObject({ code: 1, error: { rspCode: -56 } });
    expect((await cmd(app, t, 'GetMdAlarm', { channel: 0 })).body[0].value.MdAlarm.newSens.sensDef).toBe(10);
  });

  it('can fail or silently ignore chosen commands', async () => {
    const { app } = createMockCamera({ ...creds, settingsFailures: ['SetWhiteLed'], ignoreWrites: ['SetIrLights'] });
    const t = await tok(app);
    expect((await cmd(app, t, 'SetWhiteLed', { WhiteLed: { channel: 0, mode: 0, bright: 10 } })).body[0].code).toBe(1);
    const ignored = await cmd(app, t, 'SetIrLights', { IrLights: { channel: 0, state: 'Off' } });
    expect(ignored.body[0]).toMatchObject({ code: 0, value: { rspCode: 200 } });
    expect((await cmd(app, t, 'GetIrLights', { channel: 0 })).body[0].value.IrLights.state).toBe('Auto');
  });

  it('counts reboots and drops connections while rebooting', async () => {
    const { app, state } = createMockCamera(creds);
    const t = await tok(app);
    expect((await cmd(app, t, 'Reboot', {})).body[0].code).toBe(0);
    expect(state.reboots).toBe(1);
    await expect(cmd(app, t, 'GetDevInfo', {})).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** `npx vitest run test/mockCamera.test.ts` should fail.

- [ ] **Step 3: Implement in `test/mock-camera/server.ts`**

1. Add the options and state fields listed in Interfaces. The initial `state.settings` is:

```ts
function initialSettings() {
  const ALL = '1'.repeat(168);
  return {
    Rec: { enable: 1, postRec: '15 Seconds', preRec: 1, saveDay: 7, schedule: { channel: 0, table: { MD: ALL, AI_PEOPLE: ALL, AI_VEHICLE: ALL, AI_DOG_CAT: ALL, TIMING: '0'.repeat(168) } } },
    MdAlarm: { channel: 0, useNewSens: 1, newSens: { sensDef: 10 } },
    AiAlarm: {
      people: { channel: 0, ai_type: 'people', sensitivity: 60, stay_time: 3 },
      vehicle: { channel: 0, ai_type: 'vehicle', sensitivity: 60, stay_time: 3 },
      dog_cat: { channel: 0, ai_type: 'dog_cat', sensitivity: 60, stay_time: 3 },
    } as Record<string, { channel: number; ai_type: string; sensitivity: number; stay_time: number }>,
    Isp: { channel: 0, dayNight: 'Auto', antiFlicker: '60HZ' },
    IrLights: { channel: 0, state: 'Auto' },
    WhiteLed: { channel: 0, mode: 1, bright: 100, state: 0 },
    Osd: { channel: 0, osdChannel: { enable: 1, name: 'Den', pos: 'Lower Right' }, osdTime: { enable: 1, pos: 'Top Center' }, watermark: 1 },
    HddInfo: [{ capacity: 61047, size: 60670, mount: 1, format: 1, number: 0, storageType: 2 }],
  };
}

// Deep merge of a partial Set param into the stored object (how the firmware
// treats partial params, measured 2026-09-26).
function merge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      merge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}

const POSITIONS = ['Upper Left', 'Top Center', 'Upper Right', 'Lower Left', 'Bottom Center', 'Lower Right'];
// Firmware-like range checks: -56 for a bad number, -67 for a bad enum.
function settingsError(cmd: string, p: Record<string, any>): number | null {
  if (cmd === 'SetMdAlarm') {
    const s = p?.MdAlarm?.newSens?.sensDef;
    if (s !== undefined && !(Number.isInteger(s) && s >= 1 && s <= 50)) return -56;
  }
  if (cmd === 'SetAiAlarm') {
    const s = p?.AiAlarm?.sensitivity;
    if (s !== undefined && !(Number.isInteger(s) && s >= 0 && s <= 100)) return -56;
    if (!['people', 'vehicle', 'dog_cat'].includes(p?.AiAlarm?.ai_type)) return -67;
  }
  if (cmd === 'SetIsp' && p?.Isp?.dayNight !== undefined && !['Auto', 'Color', 'Black&White'].includes(p.Isp.dayNight)) return -67;
  if (cmd === 'SetIrLights' && !['Auto', 'Off'].includes(p?.IrLights?.state)) return -67;
  if (cmd === 'SetWhiteLed') {
    const w = p?.WhiteLed ?? {};
    if (w.mode !== undefined && ![0, 1, 2, 3].includes(w.mode)) return -67;
    if (w.bright !== undefined && !(Number.isInteger(w.bright) && w.bright >= 0 && w.bright <= 100)) return -56;
  }
  if (cmd === 'SetOsd') {
    const o = p?.Osd ?? {};
    for (const part of [o.osdChannel, o.osdTime]) if (part?.pos !== undefined && !POSITIONS.includes(part.pos)) return -67;
    if (o.osdChannel?.name !== undefined && (typeof o.osdChannel.name !== 'string' || o.osdChannel.name.length > 31)) return -56;
  }
  return null;
}
```

2. In the POST handler, after the token check, add the Get and Set dispatch before the final "not supported" reply:

```ts
    const S = state.settings;
    const GETS: Record<string, () => unknown> = {
      GetRecV20: () => ({ Rec: S.Rec }),
      GetMdAlarm: () => ({ MdAlarm: S.MdAlarm }),
      GetAiAlarm: () => ({ AiAlarm: S.AiAlarm[param?.ai_type] ?? S.AiAlarm.people }),
      GetIsp: () => ({ Isp: S.Isp }),
      GetIrLights: () => ({ IrLights: { state: S.IrLights.state } }),
      GetWhiteLed: () => ({ WhiteLed: S.WhiteLed }),
      GetOsd: () => ({ Osd: S.Osd }),
      GetHddInfo: () => ({ HddInfo: S.HddInfo }),
    };
    if (GETS[cmd]) {
      res.json([{ cmd, code: 0, value: GETS[cmd]() }]);
      return;
    }
    const SETS: Record<string, (p: any) => void> = {
      SetRecV20: (p) => merge(S.Rec, p.Rec ?? {}),
      SetMdAlarm: (p) => merge(S.MdAlarm, p.MdAlarm ?? {}),
      SetAiAlarm: (p) => merge(S.AiAlarm[p.AiAlarm.ai_type], p.AiAlarm),
      SetIsp: (p) => merge(S.Isp, p.Isp ?? {}),
      SetIrLights: (p) => merge(S.IrLights, p.IrLights ?? {}),
      SetWhiteLed: (p) => merge(S.WhiteLed, p.WhiteLed ?? {}),
      SetOsd: (p) => merge(S.Osd, p.Osd ?? {}),
    };
    if (SETS[cmd]) {
      state.setCalls.push(cmd);
      const rsp = (opts.settingsFailures ?? []).includes(cmd) ? -67 : settingsError(cmd, param);
      if (rsp !== null) {
        res.json([{ cmd, code: 1, error: { detail: 'rejected by mock', rspCode: rsp } }]);
        return;
      }
      if (!(opts.ignoreWrites ?? []).includes(cmd)) SETS[cmd](param);
      res.json([{ cmd, code: 0, value: { rspCode: 200 } }]);
      return;
    }
    if (cmd === 'Reboot') {
      state.reboots++;
      state.offline = true;
      setTimeout(() => (state.offline = false), opts.rebootMs ?? 50);
      res.json([{ cmd, code: 0, value: { rspCode: 200 } }]);
      return;
    }
```

Also add `rebootMs?: number` to the options. `state.offline` must make every request drop the socket. Check how the existing `offline` middleware behaves (Plan 2) and reuse it; don't add a second mechanism. Make `settings` resettable by giving each `createMockCamera` call its own `initialSettings()`.

- [ ] **Step 4: Verify and commit.** Run `test/mockCamera.test.ts` twice, then the full suite.

```bash
git add test/mock-camera/server.ts test/mockCamera.test.ts
git commit -m "test: mock camera settings commands, failures and reboot like the firmware"
```

---

### Task 3: Settings, device and reboot API

**Files:**
- Create: `server/routes/settings.ts`, `server/reolink/device.ts`
- Modify: `server/reolink/client.ts` (add `cameraCertificate()`), `server/routes/api.ts` (mount the router; add `webUiUrl` to `/api/cameras`), `server/cameraRegistry.ts` (add `webUiUrlOf(cam)`)
- Test: `test/settingsRoutes.test.ts`

**Interfaces:**
- **Consumes:** Task 1 (everything), Task 2's mock, `getClient(id)`, `client.command<T>(cmd, param)`, `getCamera(id)`, `CameraError`.
- **Produces:**
  - `DeviceInfo = { model: string; firmware: string; hardware: string; name: string; storage: { totalMb: number; usedMb: number; mounted: boolean } | null; certificate: { subject: string; issuer: string; validTo: string; daysLeft: number } | null; webUiUrl: string }`
  - `readDetection(client)`, `readImage(client)`, `readDevice(cam, client)` in `server/reolink/device.ts`
  - `client.cameraCertificate(): Promise<{ subject; issuer; validTo } | null>`
  - the routes from Global Constraints
  - `webUiUrlOf(cam: CameraConfig): string` = `https://${host without :port}/`

- [ ] **Step 1: Failing test `test/settingsRoutes.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { resetClients } from '../server/reolink/clients';
import { SESSION_COOKIE, signSession } from '../server/session';
import { createMockCamera, MockCameraOptions, MockState } from './mock-camera/server';

const auth = `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`;
let cam: Server;
let state: MockState;

async function start(opts: Partial<MockCameraOptions> = {}) {
  if (cam) await new Promise<void>((r) => cam.close(() => r()));
  const mock = createMockCamera({ user: 'u', password: 'p', ...opts });
  state = mock.state;
  cam = mock.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  setCameras([{ id: 'cam1', name: 'Den', host: `127.0.0.1:${(cam.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p' }]);
  resetClients();
}
beforeEach(() => start());
afterEach(async () => {
  await new Promise<void>((r) => cam.close(() => r()));
  setCameras([]);
});

const put = (section: string, body: unknown) =>
  request(createApp()).put(`/api/cameras/cam1/settings/${section}`).set('Cookie', auth).set('Origin', 'http://127.0.0.1').send(body as object);

describe('settings API', () => {
  it('reads detection and image settings', async () => {
    const res = await request(createApp()).get('/api/cameras/cam1/settings').set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.body.detection).toMatchObject({ recording: true, motionRecording: 'on', motionSensitivity: 41 });
    expect(res.body.image.osd.name).toBe('Den');
  });

  it('saves detection fields, re-reads, and reports each field', async () => {
    const res = await put('detection', { motionSensitivity: 30, ai: { person: { sensitivity: 80 } } });
    expect(res.status).toBe(200);
    expect(res.body.fields).toEqual({ motionSensitivity: { ok: true }, 'ai.person.sensitivity': { ok: true } });
    expect(res.body.settings.motionSensitivity).toBe(30);
    expect(state.settings.MdAlarm.newSens.sensDef).toBe(21);
  });

  // Review focus 3.
  it('reports a partial failure per field and keeps the fields that saved', async () => {
    await start({ settingsFailures: ['SetWhiteLed'] });
    const res = await put('image', { dayNight: 'color', spotlight: { mode: 'off' }, osd: { name: 'Porch' } });
    expect(res.status).toBe(207);
    expect(res.body.fields).toEqual({ dayNight: { ok: true }, spotlight: { ok: false, error: 'camera_rejected' }, osd: { ok: true } });
    expect(res.body.settings.dayNight).toBe('color');
    expect(res.body.settings.spotlight.mode).toBe('auto');
  });

  // Review focus 1.
  it('treats an ignored write as not applied', async () => {
    await start({ ignoreWrites: ['SetIrLights'] });
    const res = await put('image', { irLights: 'off' });
    expect(res.status).toBe(207);
    expect(res.body.fields.irLights).toEqual({ ok: false, error: 'not_applied' });
  });

  // Review focus 2.
  it.each([
    ['detection', { motionSensitivity: 99 }],
    ['detection', { ai: { cat: {} } }],
    ['image', { osd: { name: 'x'.repeat(40) } }],
    ['image', { dayNight: 'Purple' }],
    ['image', { extra: 1 }],
  ])('rejects invalid %s input before calling the camera', async (section, body) => {
    const res = await put(section, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(state.setCalls).toEqual([]);
  });

  // Review focus 5.
  it('does not touch a custom schedule when saving other fields', async () => {
    state.settings.Rec.schedule.table.MD = '1'.repeat(84) + '0'.repeat(84);
    const res = await put('detection', { recording: false });
    expect(res.status).toBe(200);
    expect(res.body.settings.motionRecording).toBe('custom');
    expect(state.settings.Rec.schedule.table.MD).toBe('1'.repeat(84) + '0'.repeat(84));
  });

  it('reads device info with storage used and free', async () => {
    const res = await request(createApp()).get('/api/cameras/cam1/device').set('Cookie', auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: 'RLC-1224A', storage: { totalMb: 61047, usedMb: 377, mounted: true }, certificate: null });
    expect(res.body.webUiUrl).toBe('https://127.0.0.1/');
  });

  // Review focus 4.
  it('reboots only with the exact confirmation body', async () => {
    const app = createApp();
    const post = (body: object) => request(app).post('/api/cameras/cam1/reboot').set('Cookie', auth).set('Origin', 'http://127.0.0.1').send(body);
    expect((await post({})).status).toBe(400);
    expect((await post({ confirm: 'yes' })).status).toBe(400);
    expect(state.reboots).toBe(0);
    const ok = await post({ confirm: 'reboot' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect(state.reboots).toBe(1);
  });

  it('lists cameras with a LAN web UI link built from the host without its port', async () => {
    const res = await request(createApp()).get('/api/cameras').set('Cookie', auth);
    expect(res.body).toEqual([{ id: 'cam1', name: 'Den', webUiUrl: 'https://127.0.0.1/' }]);
  });

  it('maps an offline camera to 503', async () => {
    state.offline = true;
    const res = await request(createApp()).get('/api/cameras/cam1/settings').set('Cookie', auth);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('camera_offline');
  });
});
```

Before writing the test, check the same-origin requirement for state-changing requests. Look at `server/middleware/requireSameOrigin.ts` and at how existing tests send `Origin` or `Sec-Fetch-Site`, and use the same headers as those tests. If existing tests use something else, adapt `.set('Origin', …)` to match.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.**

`server/cameraRegistry.ts`: add

```ts
// The camera's own web UI, by LAN address: it's reachable from the home
// network only (docs/reolink-api.md, "Camera authentication").
export function webUiUrlOf(cam: CameraConfig): string {
  const host = cam.host.startsWith('[') ? cam.host.slice(0, cam.host.indexOf(']') + 1) : cam.host.split(':')[0];
  return `https://${host}/`;
}
```

In `listCameras()`, or in the `/api/cameras` route, return `{ id, name, webUiUrl: webUiUrlOf(c) }`. Update `CameraSummary` in both `server/cameraRegistry.ts` and `web/src/lib/stores.ts` to include `webUiUrl: string`.

`server/reolink/client.ts`: add

```ts
  // The certificate the camera presents (subject, issuer, expiry). The camera's
  // GetCertificateInfo only says whether a custom one is installed.
  async cameraCertificate(): Promise<{ subject: string; issuer: string; validTo: string } | null> {
    if (this.cam.protocol !== 'https') return null;
    const [host, port] = this.cam.host.split(':');
    return new Promise((resolve) => {
      const socket = tlsConnect(
        { host, port: Number(port) || 443, servername: this.cam.tlsServername, rejectUnauthorized: false, timeout: this.timeoutMs },
        () => {
          const c = socket.getPeerCertificate();
          socket.end();
          if (!c || !c.valid_to) return resolve(null);
          resolve({ subject: String(c.subject?.CN ?? ''), issuer: String(c.issuer?.O ?? c.issuer?.CN ?? ''), validTo: new Date(c.valid_to).toISOString() });
        },
      );
      socket.on('error', () => resolve(null));
      socket.on('timeout', () => {
        socket.destroy();
        resolve(null);
      });
    });
  }
```

Use `import { connect as tlsConnect } from 'tls';`. `rejectUnauthorized: false` is acceptable here: this only *reads* the certificate to display it, and sends nothing.

`server/reolink/device.ts`:

```ts
import { CameraConfig, webUiUrlOf } from '../cameraRegistry';
import { ReolinkClient } from './client';
import { AI_KINDS, AI_TYPE, detectionFrom, DetectionSettings, imageFrom, ImageSettings } from './settings';

// Reads go through command() one at a time: they share the camera's API gate.
export async function readDetection(client: ReolinkClient): Promise<DetectionSettings> {
  const rec = await client.command('GetRecV20', { channel: 0 });
  const md = await client.command('GetMdAlarm', { channel: 0 });
  const ai = {} as Record<(typeof AI_KINDS)[number], unknown>;
  for (const kind of AI_KINDS) ai[kind] = await client.command('GetAiAlarm', { channel: 0, ai_type: AI_TYPE[kind] });
  return detectionFrom({ rec, md, ai });
}

export async function readImage(client: ReolinkClient): Promise<ImageSettings> {
  const isp = await client.command('GetIsp', { channel: 0 });
  const ir = await client.command('GetIrLights', { channel: 0 });
  const wl = await client.command('GetWhiteLed', { channel: 0 });
  const osd = await client.command('GetOsd', { channel: 0 });
  return imageFrom({ isp, ir, wl, osd });
}

export interface DeviceInfo {
  model: string;
  firmware: string;
  hardware: string;
  name: string;
  storage: { totalMb: number; usedMb: number; mounted: boolean } | null;
  certificate: { subject: string; issuer: string; validTo: string; daysLeft: number } | null;
  webUiUrl: string;
}

export async function readDevice(cam: CameraConfig, client: ReolinkClient): Promise<DeviceInfo> {
  const dev = ((await client.command<{ DevInfo?: Record<string, string> }>('GetDevInfo')).DevInfo ?? {}) as Record<string, string>;
  const hdd = (await client.command<{ HddInfo?: { capacity: number; size: number; mount: number }[] }>('GetHddInfo')).HddInfo?.[0];
  const cert = await client.cameraCertificate();
  return {
    model: dev.model ?? '',
    firmware: dev.firmVer ?? '',
    hardware: dev.hardVer ?? '',
    name: dev.name ?? '',
    // GetHddInfo: capacity is the total and size the FREE space, in MB.
    storage: hdd ? { totalMb: hdd.capacity, usedMb: hdd.capacity - hdd.size, mounted: hdd.mount === 1 } : null,
    certificate: cert ? { ...cert, daysLeft: Math.floor((Date.parse(cert.validTo) - Date.now()) / 86_400_000) } : null,
    webUiUrl: webUiUrlOf(cam),
  };
}
```

`server/routes/settings.ts`:

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { getCamera } from '../cameraRegistry';
import { CameraError } from '../reolink/client';
import { getClient } from '../reolink/clients';
import { readDetection, readDevice, readImage } from '../reolink/device';
import {
  detectionCommands, DetectionPatch, imageCommands, ImagePatch, patchApplied,
  SettingsCommand, validateDetectionPatch, validateImagePatch,
} from '../reolink/settings';
import { logger } from '../logger';

export const settingsRouter = Router();

function cameraOr404(req: Request, res: Response) {
  const cam = getCamera(String(req.params.id));
  const client = cam && getClient(cam.id);
  if (!cam || !client) {
    res.status(404).json({ error: 'unknown_camera' });
    return null;
  }
  return { cam, client };
}

function fail(err: unknown, cameraId: string, res: Response, next: NextFunction) {
  if (err instanceof CameraError) {
    logger.warn({ cameraId, code: err.code, message: err.message }, 'camera_request_failed');
    res.status(err.code === 'camera_error' ? 502 : 503).json({ error: err.code });
    return;
  }
  next(err);
}

// One command at a time; a failing command doesn't stop the rest (review
// focus 3). Every field is then judged against a fresh re-read.
async function apply(
  client: NonNullable<ReturnType<typeof getClient>>,
  commands: SettingsCommand[],
): Promise<Record<string, { ok: boolean; error?: string }>> {
  const fields: Record<string, { ok: boolean; error?: string }> = {};
  for (const c of commands) {
    try {
      await client.command(c.cmd, c.param);
      fields[c.field] = { ok: true };
    } catch (err) {
      if (err instanceof CameraError && err.code !== 'camera_error') throw err; // offline/auth: whole request fails
      fields[c.field] = { ok: false, error: 'camera_rejected' };
    }
  }
  return fields;
}

settingsRouter.get('/api/cameras/:id/settings', async (req, res, next) => {
  const c = cameraOr404(req, res);
  if (!c) return;
  try {
    res.json({ detection: await readDetection(c.client), image: await readImage(c.client) });
  } catch (err) {
    fail(err, c.cam.id, res, next);
  }
});

settingsRouter.put('/api/cameras/:id/settings/:section', async (req, res, next) => {
  const section = String(req.params.section);
  if (section !== 'detection' && section !== 'image') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const c = cameraOr404(req, res);
  if (!c) return;
  const v = section === 'detection' ? validateDetectionPatch(req.body) : validateImagePatch(req.body);
  if (!v.ok) {
    res.status(400).json({ error: 'bad_request', details: v.details });
    return;
  }
  try {
    const commands =
      section === 'detection'
        ? detectionCommands(v.patch as DetectionPatch)
        : imageCommands(v.patch as ImagePatch, await readImage(c.client));
    const fields = await apply(c.client, commands);
    const settings = section === 'detection' ? await readDetection(c.client) : await readImage(c.client);
    for (const [field, r] of Object.entries(fields)) {
      if (r.ok && !patchApplied(field, v.patch, settings)) fields[field] = { ok: false, error: 'not_applied' };
    }
    const allOk = Object.values(fields).every((f) => f.ok);
    res.status(allOk ? 200 : 207).json({ fields, settings });
  } catch (err) {
    fail(err, c.cam.id, res, next);
  }
});

settingsRouter.get('/api/cameras/:id/device', async (req, res, next) => {
  const c = cameraOr404(req, res);
  if (!c) return;
  try {
    res.json(await readDevice(c.cam, c.client));
  } catch (err) {
    fail(err, c.cam.id, res, next);
  }
});

// Review focus 4: only the exact confirmation body reboots.
settingsRouter.post('/api/cameras/:id/reboot', async (req, res, next) => {
  const c = cameraOr404(req, res);
  if (!c) return;
  if (req.body?.confirm !== 'reboot' || Object.keys(req.body).length !== 1) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  try {
    await c.client.command('Reboot', {});
    logger.info({ cameraId: c.cam.id }, 'camera_reboot_requested');
    res.json({ ok: true });
  } catch (err) {
    fail(err, c.cam.id, res, next);
  }
});
```

Mount it in `server/routes/api.ts` with `apiRouter.use(settingsRouter);`, placed before the `/api` 404. Check that `express.json()` already parses bodies on `/api`. If it does not, add `express.json({ limit: '16kb' })` for these routes only.

Also check `client.command`'s signature. If it throws a `CameraError('camera_error', …)` for a non-zero `code` with a negative rspCode other than -6, the `apply()` logic above holds. If it throws something else for a rejected command, adapt the catch and note that in the report.

- [ ] **Step 4: Verify and commit.** Run the new file twice, then the full suite, `npm run build` and `npm run check`.

```bash
git add server test
git commit -m "feat: camera settings, device info and guarded reboot API with per-field results"
```

---

### Task 4: App preferences

**Files:**
- Create: `server/preferences.ts`, `server/routes/preferences.ts`
- Modify: `server/routes/api.ts`, `test/setup.ts` (set a per-worker `PREFS_FILE`)
- Test: `test/preferences.test.ts`

**Interfaces:**
- **Produces:**
  - `Preferences = { defaultCamera: string | null; liveQuality: 'sub' | 'main'; eventFilter: 'all' | 'person' | 'vehicle' | 'pet' | 'motion'; timelineZoom: 24 | 6 | 1 }`
  - `DEFAULT_PREFERENCES`
  - `getPreferences(email): Promise<Preferences>`
  - `savePreferences(email, patch): Promise<Preferences>`
  - `validatePreferencesPatch(body): { ok: true; patch } | { ok: false; details }`
  - routes `GET/PUT /api/preferences`

- [ ] **Step 1: Failing test `test/preferences.test.ts`**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFileSync, rmSync } from 'fs';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { DEFAULT_PREFERENCES } from '../server/preferences';
import { SESSION_COOKIE, signSession } from '../server/session';

const as = (email: string) => `${SESSION_COOKIE}=${signSession(email)}`;
const klaus = as('klaus@klaushofrichter.net');

beforeEach(() => {
  rmSync(process.env.PREFS_FILE!, { force: true });
  setCameras([{ id: 'cam1', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' }]);
});

describe('preferences', () => {
  it('returns defaults when nothing is stored', async () => {
    const res = await request(createApp()).get('/api/preferences').set('Cookie', klaus);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULT_PREFERENCES);
  });

  it('saves a partial update, merges it and persists it to the file', async () => {
    const res = await request(createApp()).put('/api/preferences').set('Cookie', klaus).set('Origin', 'http://127.0.0.1').send({ liveQuality: 'main', timelineZoom: 6 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...DEFAULT_PREFERENCES, liveQuality: 'main', timelineZoom: 6 });
    const file = JSON.parse(readFileSync(process.env.PREFS_FILE!, 'utf8'));
    expect(file['klaus@klaushofrichter.net'].liveQuality).toBe('main');
    const again = await request(createApp()).get('/api/preferences').set('Cookie', klaus);
    expect(again.body.timelineZoom).toBe(6);
  });

  it.each([
    [{ liveQuality: 'ultra' }],
    [{ timelineZoom: 12 }],
    [{ eventFilter: 'cat' }],
    [{ defaultCamera: 'nope' }],
    [{ theme: 'dark' }],
  ])('rejects %j', async (body) => {
    const res = await request(createApp()).put('/api/preferences').set('Cookie', klaus).set('Origin', 'http://127.0.0.1').send(body);
    expect(res.status).toBe(400);
  });

  it('accepts a configured camera and null as the default camera', async () => {
    const put = (defaultCamera: string | null) =>
      request(createApp()).put('/api/preferences').set('Cookie', klaus).set('Origin', 'http://127.0.0.1').send({ defaultCamera });
    expect((await put('cam1')).body.defaultCamera).toBe('cam1');
    expect((await put(null)).body.defaultCamera).toBeNull();
  });

  it('survives a corrupted file by falling back to defaults', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(process.env.PREFS_FILE!, '{not json');
    const res = await request(createApp()).get('/api/preferences').set('Cookie', klaus);
    expect(res.body).toEqual(DEFAULT_PREFERENCES);
  });
});
```

In `test/setup.ts`, set `process.env.PREFS_FILE ??= join(tmpdir(), \`cams-test-prefs-${process.env.VITEST_POOL_ID ?? process.pid}.json\`)` next to the per-worker `CACHE_DIR`. The only allowed email in tests is klaus, so the test covers only one user. The map is still keyed by email.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.**

`server/preferences.ts`:

```ts
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { getCamera } from './cameraRegistry';
import { logger } from './logger';

export interface Preferences {
  defaultCamera: string | null;
  liveQuality: 'sub' | 'main';
  eventFilter: 'all' | 'person' | 'vehicle' | 'pet' | 'motion';
  timelineZoom: 24 | 6 | 1;
}

export const DEFAULT_PREFERENCES: Preferences = { defaultCamera: null, liveQuality: 'sub', eventFilter: 'all', timelineZoom: 24 };

const file = () => process.env.PREFS_FILE || join(tmpdir(), 'cams-preferences.json');
let writing: Promise<unknown> = Promise.resolve();

async function readAll(): Promise<Record<string, Partial<Preferences>>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ err: (err as Error).message }, 'preferences file unreadable; using defaults');
    return {};
  }
}

export async function getPreferences(email: string): Promise<Preferences> {
  return { ...DEFAULT_PREFERENCES, ...((await readAll())[email.toLowerCase()] ?? {}) };
}

// Writes are serialized and atomic (temp file + rename), so two saves can't
// interleave and a crash never leaves half a file on the volume.
export function savePreferences(email: string, patch: Partial<Preferences>): Promise<Preferences> {
  const run = writing.then(async () => {
    const all = await readAll();
    const key = email.toLowerCase();
    const next = { ...DEFAULT_PREFERENCES, ...(all[key] ?? {}), ...patch };
    all[key] = next;
    await fs.mkdir(dirname(file()), { recursive: true });
    const tmp = `${file()}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(all, null, 2));
    await fs.rename(tmp, file());
    return next;
  });
  writing = run.catch(() => undefined);
  return run;
}

export function validatePreferencesPatch(body: unknown): { ok: true; patch: Partial<Preferences> } | { ok: false; details: string[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, details: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const details: string[] = [];
  for (const k of Object.keys(b)) if (!(k in DEFAULT_PREFERENCES)) details.push(`${k}: unknown field`);
  if ('defaultCamera' in b && b.defaultCamera !== null && !(typeof b.defaultCamera === 'string' && getCamera(b.defaultCamera))) details.push('defaultCamera: a configured camera id or null');
  if ('liveQuality' in b && b.liveQuality !== 'sub' && b.liveQuality !== 'main') details.push('liveQuality: sub or main');
  if ('eventFilter' in b && !['all', 'person', 'vehicle', 'pet', 'motion'].includes(b.eventFilter as string)) details.push('eventFilter: all, person, vehicle, pet or motion');
  if ('timelineZoom' in b && ![24, 6, 1].includes(b.timelineZoom as number)) details.push('timelineZoom: 24, 6 or 1');
  return details.length ? { ok: false, details } : { ok: true, patch: b as Partial<Preferences> };
}
```

`server/routes/preferences.ts`:

```ts
import { Router } from 'express';
import { currentUser } from '../middleware/requireAuth';
import { getPreferences, savePreferences, validatePreferencesPatch } from '../preferences';

export const preferencesRouter = Router();

preferencesRouter.get('/api/preferences', async (req, res, next) => {
  try {
    res.json(await getPreferences(currentUser(req)!.email));
  } catch (err) {
    next(err);
  }
});

preferencesRouter.put('/api/preferences', async (req, res, next) => {
  const v = validatePreferencesPatch(req.body);
  if (!v.ok) {
    res.status(400).json({ error: 'bad_request', details: v.details });
    return;
  }
  try {
    res.json(await savePreferences(currentUser(req)!.email, v.patch));
  } catch (err) {
    next(err);
  }
});
```

Mount it with `apiRouter.use(preferencesRouter)` before the `/api` 404.

- [ ] **Step 4: Verify and commit.**

```bash
git add server test
git commit -m "feat: per-user app preferences stored atomically on the data volume"
```

---

### Task 5: Build date and About data

**Files:**
- Modify:
  - `Dockerfile` (`ARG BUILD_DATE`, `ENV BUILD_DATE`)
  - `.github/workflows/deploy-production.yml` and `.github/workflows/build-push.yml`: add `BUILD_DATE=${{ github.event.head_commit.timestamp || github.event.repository.pushed_at }}` under `build-args`, or compute it in a prior step with `date -u +%Y-%m-%dT%H:%M:%SZ` and pass `steps.<id>.outputs`. Use the step approach; it always works.
  - `server/version.ts` (add `buildDate()`)
  - `server/routes/api.ts` (`/api/me` also returns `buildDate`)
  - `web/src/lib/stores.ts` (`Me.buildDate`)
- Create: `web/src/lib/licences.ts` (the credits list)
- Test: `test/version.test.ts` (extend, or create if missing)

**Interfaces:**
- **Produces:**
  - `buildDate(): string | null`, which reads `process.env.BUILD_DATE` and returns null when it is unset or invalid
  - `/api/me` → `{ email, version, buildDate }`
  - `LICENCES: { name: string; url: string; licence: string; use: string }[]`

- [ ] **Step 1: Failing test**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { buildDate } from '../server/version';
import { SESSION_COOKIE, signSession } from '../server/session';

afterEach(() => {
  delete process.env.BUILD_DATE;
});

describe('build date', () => {
  it('is null when not stamped, and ISO when stamped', async () => {
    expect(buildDate()).toBeNull();
    process.env.BUILD_DATE = '2026-09-26T12:48:33Z';
    expect(buildDate()).toBe('2026-09-26T12:48:33.000Z');
    process.env.BUILD_DATE = 'garbage';
    expect(buildDate()).toBeNull();
  });

  it('is reported by /api/me', async () => {
    process.env.BUILD_DATE = '2026-09-26T12:48:33Z';
    const res = await request(createApp()).get('/api/me').set('Cookie', `${SESSION_COOKIE}=${signSession('klaus@klaushofrichter.net')}`);
    expect(res.body).toMatchObject({ email: 'klaus@klaushofrichter.net', buildDate: '2026-09-26T12:48:33.000Z' });
  });
});
```

- [ ] **Step 2: Implement.**

```ts
// server/version.ts (append)
// Stamped by the Docker build (ARG BUILD_DATE, set by the workflows).
export function buildDate(): string | null {
  const raw = process.env.BUILD_DATE;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
```

In the `Dockerfile` runtime stage, next to `APP_VERSION`:

```dockerfile
ARG BUILD_DATE=
ENV BUILD_DATE=$BUILD_DATE
```

In each workflow, add a step before the build step. The build step already has `build-args` with `APP_VERSION`; append `BUILD_DATE`:

```yaml
      - name: Build timestamp
        id: built
        run: echo "at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_OUTPUT"
```

```yaml
          build-args: |
            APP_VERSION=...unchanged...
            BUILD_DATE=${{ steps.built.outputs.at }}
```

Create `web/src/lib/licences.ts`. Before writing it, check each package's licence in its `node_modules/<pkg>/package.json`, and correct the list if any differs:

```ts
// Third-party software shipped in the app or its image. Licences checked
// against each package's package.json when this list was written.
export const LICENCES = [
  { name: 'Svelte', url: 'https://svelte.dev', licence: 'MIT', use: 'web interface' },
  { name: 'mpegts.js', url: 'https://github.com/xqq/mpegts.js', licence: 'Apache-2.0', use: 'live video playback' },
  { name: 'Express', url: 'https://expressjs.com', licence: 'MIT', use: 'web server' },
  { name: 'pino', url: 'https://getpino.io', licence: 'MIT', use: 'logging' },
  { name: 'google-auth-library', url: 'https://github.com/googleapis/google-auth-library-nodejs', licence: 'Apache-2.0', use: 'Google sign-in' },
  { name: 'jsonwebtoken', url: 'https://github.com/auth0/node-jsonwebtoken', licence: 'MIT', use: 'sessions' },
  { name: 'express-rate-limit', url: 'https://github.com/express-rate-limit/express-rate-limit', licence: 'MIT', use: 'rate limiting' },
  { name: 'FFmpeg', url: 'https://ffmpeg.org', licence: 'LGPL-2.1+ / GPL-2.0+ (Alpine build)', use: 'clip thumbnails (separate program)' },
  { name: 'Node.js', url: 'https://nodejs.org', licence: 'MIT', use: 'runtime' },
  { name: 'reolink_aio', url: 'https://github.com/starkillerOG/reolink_aio', licence: 'MIT', use: 'reference for the camera API (not shipped)' },
] as const;
```

- [ ] **Step 3: Verify and commit.** Run `npx vitest run`, validate the workflow YAML (`python3 -c "import yaml,glob;[yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]"`), then `docker build --build-arg BUILD_DATE=2026-09-26T00:00:00Z -t cams:p4 . && docker run --rm cams:p4 sh -c 'echo $BUILD_DATE'`.

```bash
git add Dockerfile .github server web/src/lib test
git commit -m "feat: build date stamped into the image and reported by /api/me; credits list"
```

---

### Task 6: Settings and About pages, and the camera web UI link

**Files:**
- Create:
  - `web/src/lib/settings.ts` (client types plus `saveSection()`)
  - `web/src/lib/preferences.ts` (store plus load and save)
  - `web/src/components/SettingsCard.svelte`
  - `web/src/components/SaveState.svelte`
- Replace: `web/src/pages/Settings.svelte`, `web/src/pages/About.svelte`
- Modify:
  - `web/src/components/TopBar.svelte` (web UI link to the right of the camera picker)
  - `web/src/App.svelte` (load preferences; default camera)
  - `web/src/pages/Live.svelte` (preferred quality when nothing is stored)
  - `web/src/pages/Recordings.svelte` (preferred filter when the URL has none)
  - `web/src/components/Timeline.svelte` (initial zoom from preferences)
  - `web/src/lib/icons.ts` (`external`, `power`)
- Test: `web/src/lib/settings.test.ts`

**Interfaces:**
- **Consumes:** the Task 3 and Task 4 routes, `getJson`, the `cameras`, `selectedCameraId` and `me` stores, and `Icon`.
- **Produces:**
  - `web/src/lib/settings.ts`: `DetectionSettings`, `ImageSettings`, `DeviceInfo`, `SaveResult` (the same shapes as the server's) and `putJson<T>(url, body): Promise<{ status: number; body: T }>`
  - `diffPatch(original, edited)`: returns only the changed fields, as a deep partial, and **never** includes a schedule whose original is `'custom'` unless the user changed it
  - `preferences`: `Writable<Preferences | null>`
  - `loadPreferences()` and `savePreferences(patch)`
  - The test ids from Global Constraints

- [ ] **Step 1: Failing test `web/src/lib/settings.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { diffPatch } from './settings';

const detection = {
  recording: true,
  motionRecording: 'custom' as const,
  motionSensitivity: 41,
  ai: { person: { record: 'on' as const, sensitivity: 60 }, vehicle: { record: 'on' as const, sensitivity: 60 }, pet: { record: 'off' as const, sensitivity: 60 } },
};

describe('diffPatch', () => {
  it('sends only changed fields', () => {
    const edited = structuredClone(detection);
    edited.motionSensitivity = 30;
    edited.ai.pet.sensitivity = 80;
    expect(diffPatch(detection, edited)).toEqual({ motionSensitivity: 30, ai: { pet: { sensitivity: 80 } } });
  });

  // Review focus 5.
  it('never sends an untouched custom schedule', () => {
    const edited = structuredClone(detection);
    edited.recording = false;
    expect(diffPatch(detection, edited)).toEqual({ recording: false });
  });

  it('returns an empty patch when nothing changed', () => {
    expect(diffPatch(detection, structuredClone(detection))).toEqual({});
  });
});
```

- [ ] **Step 2: Implement `web/src/lib/settings.ts`**

```ts
export type Schedule = 'on' | 'off' | 'custom';
export type AiKind = 'person' | 'vehicle' | 'pet';
export interface DetectionSettings {
  recording: boolean;
  motionRecording: Schedule;
  motionSensitivity: number;
  ai: Record<AiKind, { record: Schedule; sensitivity: number }>;
}
export const OSD_POSITIONS = ['Upper Left', 'Top Center', 'Upper Right', 'Lower Left', 'Bottom Center', 'Lower Right'] as const;
export interface ImageSettings {
  dayNight: 'auto' | 'color' | 'blackwhite';
  irLights: 'auto' | 'off';
  spotlight: { mode: 'off' | 'auto' | 'night' | 'schedule'; brightness: number };
  osd: { showName: boolean; name: string; namePosition: string; showTime: boolean; timePosition: string };
}
export interface DeviceInfo {
  model: string;
  firmware: string;
  hardware: string;
  name: string;
  storage: { totalMb: number; usedMb: number; mounted: boolean } | null;
  certificate: { subject: string; issuer: string; validTo: string; daysLeft: number } | null;
  webUiUrl: string;
}
export interface SaveResult<T> {
  fields: Record<string, { ok: boolean; error?: string }>;
  settings: T;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// Changed leaves only, as a deep partial. The server rejects 'custom' as a
// value, and an untouched custom schedule must never be overwritten.
export function diffPatch<T extends object>(original: T, edited: T): Partial<T> {
  const out: Obj = {};
  for (const [k, v] of Object.entries(edited as Obj)) {
    const was = (original as Obj)[k];
    if (isObj(v) && isObj(was)) {
      const inner = diffPatch(was, v);
      if (Object.keys(inner).length) out[k] = inner;
    } else if (v !== was && v !== 'custom') {
      out[k] = v;
    }
  }
  return out as Partial<T>;
}

export async function putJson<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

export async function postJson<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

export const FIELD_LABELS: Record<string, string> = {
  recording: 'Recording',
  motionRecording: 'Record on motion',
  motionSensitivity: 'Motion sensitivity',
  'ai.person.record': 'Record people',
  'ai.person.sensitivity': 'People sensitivity',
  'ai.vehicle.record': 'Record vehicles',
  'ai.vehicle.sensitivity': 'Vehicle sensitivity',
  'ai.pet.record': 'Record pets',
  'ai.pet.sensitivity': 'Pet sensitivity',
  dayNight: 'Day/night',
  irLights: 'Infrared lights',
  spotlight: 'Spotlight',
  osd: 'On-screen text',
};
```

`web/src/lib/preferences.ts`:

```ts
import { get, writable } from 'svelte/store';
import { getJson } from './api';
import { putJson } from './settings';

export interface Preferences {
  defaultCamera: string | null;
  liveQuality: 'sub' | 'main';
  eventFilter: 'all' | 'person' | 'vehicle' | 'pet' | 'motion';
  timelineZoom: 24 | 6 | 1;
}

export const preferences = writable<Preferences | null>(null);

export async function loadPreferences(): Promise<Preferences | null> {
  try {
    const p = await getJson<Preferences>('/api/preferences');
    preferences.set(p);
    return p;
  } catch {
    return null; // preferences are a convenience; the app works without them
  }
}

export async function savePreferences(patch: Partial<Preferences>): Promise<boolean> {
  const res = await putJson<Preferences>('/api/preferences', patch);
  if (res.status !== 200) return false;
  preferences.set(res.body);
  return true;
}

export const pref = <K extends keyof Preferences>(k: K): Preferences[K] | undefined => get(preferences)?.[k];
```

Before relying on `fetch` defaults, check whether `web/src/lib/api.ts`'s `getJson` sets credentials or headers the same-origin middleware needs (for example `Sec-Fetch-Site`, which browsers send automatically). Match whatever `getJson` does in `putJson` and `postJson`.

- [ ] **Step 3: `SaveState.svelte` and `SettingsCard.svelte`**

```svelte
<!-- web/src/components/SaveState.svelte -->
<script lang="ts">
  let { state, message = '' }: { state: 'idle' | 'saving' | 'saved' | 'partial' | 'error'; message?: string } = $props();
  const text = $derived(
    { idle: '', saving: 'Saving…', saved: 'Saved', partial: 'Some changes were not applied', error: message || 'Could not save' }[state],
  );
</script>

<span class="state" data-testid="save-state" data-state={state} class:ok={state === 'saved'} class:bad={state === 'error' || state === 'partial'} role="status" aria-live="polite">{text}</span>

<style>
  .state { font-size: 13px; color: var(--muted); min-height: 1em; transition: color 0.2s ease; }
  .ok { color: var(--accent); }
  .bad { color: var(--danger); }
</style>
```

```svelte
<!-- web/src/components/SettingsCard.svelte -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  let { id, title, description = '', children, footer }: { id: string; title: string; description?: string; children: Snippet; footer?: Snippet } = $props();
</script>

<section class="card" data-testid={`settings-card-${id}`} aria-labelledby={`card-${id}-title`}>
  <header>
    <h2 id={`card-${id}-title`}>{title}</h2>
    {#if description}<p>{description}</p>{/if}
  </header>
  <div class="body">{@render children()}</div>
  {#if footer}<footer>{@render footer()}</footer>{/if}
</section>

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; display: flex; flex-direction: column; gap: 14px; }
  header h2 { margin: 0; font-size: 16px; }
  header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
  .body { display: grid; gap: 12px; }
  footer { display: flex; align-items: center; gap: 12px; justify-content: flex-end; border-top: 1px solid var(--border); padding-top: 12px; }
</style>
```

- [ ] **Step 4: `web/src/pages/Settings.svelte`**

The page has one column below 900 px and two columns above. Card order: Preferences, Detection, Image, Device. Each camera card loads from the selected camera (`$selectedCameraId`) and re-loads when it changes. It keeps an `original` copy and an `edited` copy, and has a Save button (`save-<id>`) that is disabled when `diffPatch` is empty or a save is running. After a save:
- `original` and `edited` both become `res.body.settings`
- the state is `saved` (200), `partial` (207) or `error` (anything else)
- every failed field shows `<span data-testid="field-error-<field>">` with "Not applied" or "Rejected by the camera" next to its control

```svelte
<script lang="ts">
  import SettingsCard from '../components/SettingsCard.svelte';
  import SaveState from '../components/SaveState.svelte';
  import Icon from '../components/Icon.svelte';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { getJson } from '../lib/api';
  import {
    diffPatch, FIELD_LABELS, OSD_POSITIONS, postJson, putJson,
    type DetectionSettings, type DeviceInfo, type ImageSettings, type SaveResult,
  } from '../lib/settings';
  import { preferences, savePreferences, type Preferences } from '../lib/preferences';

  type State = 'idle' | 'saving' | 'saved' | 'partial' | 'error';
  const AI: { kind: 'person' | 'vehicle' | 'pet'; label: string }[] = [
    { kind: 'person', label: 'People' },
    { kind: 'vehicle', label: 'Vehicles' },
    { kind: 'pet', label: 'Pets' },
  ];

  // --- preferences ---
  let prefs: Preferences | null = $state(null);
  let prefsState: State = $state('idle');
  $effect(() => {
    if ($preferences && !prefs) prefs = structuredClone($preferences);
  });
  const prefsDirty = $derived(!!prefs && !!$preferences && Object.keys(diffPatch($preferences, prefs)).length > 0);
  async function savePrefs() {
    if (!prefs || !$preferences) return;
    prefsState = 'saving';
    prefsState = (await savePreferences(diffPatch($preferences, prefs))) ? 'saved' : 'error';
    if (prefsState === 'saved' && $preferences) prefs = structuredClone($preferences);
  }

  // --- camera cards ---
  let loadError = $state('');
  let detection: DetectionSettings | null = $state(null);
  let detectionEdit: DetectionSettings | null = $state(null);
  let detectionState: State = $state('idle');
  let detectionErrors: Record<string, string> = $state({});
  let image: ImageSettings | null = $state(null);
  let imageEdit: ImageSettings | null = $state(null);
  let imageState: State = $state('idle');
  let imageErrors: Record<string, string> = $state({});
  let device: DeviceInfo | null = $state(null);
  let seq = 0;

  $effect(() => {
    const id = $selectedCameraId;
    const mine = ++seq;
    detection = detectionEdit = image = imageEdit = device = null;
    loadError = '';
    if (!id) return;
    getJson<{ detection: DetectionSettings; image: ImageSettings }>(`/api/cameras/${encodeURIComponent(id)}/settings`)
      .then((s) => {
        if (mine !== seq) return;
        detection = s.detection;
        detectionEdit = structuredClone(s.detection);
        image = s.image;
        imageEdit = structuredClone(s.image);
      })
      .catch(() => {
        if (mine === seq) loadError = 'The camera settings could not be loaded. The camera may be offline.';
      });
    getJson<DeviceInfo>(`/api/cameras/${encodeURIComponent(id)}/device`)
      .then((d) => {
        if (mine === seq) device = d;
      })
      .catch(() => {});
  });

  const detectionDirty = $derived(!!detection && !!detectionEdit && Object.keys(diffPatch(detection, detectionEdit)).length > 0);
  const imageDirty = $derived(!!image && !!imageEdit && Object.keys(diffPatch(image, imageEdit)).length > 0);

  function errorsOf(fields: Record<string, { ok: boolean; error?: string }>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [f, r] of Object.entries(fields)) if (!r.ok) out[f] = r.error === 'not_applied' ? 'Not applied' : 'Rejected by the camera';
    return out;
  }

  async function save<T extends object>(section: 'detection' | 'image', original: T, edited: T) {
    const set = section === 'detection' ? (s: State) => (detectionState = s) : (s: State) => (imageState = s);
    set('saving');
    try {
      const res = await putJson<SaveResult<T>>(`/api/cameras/${encodeURIComponent($selectedCameraId!)}/settings/${section}`, diffPatch(original, edited));
      if (res.status !== 200 && res.status !== 207) return set('error');
      const errs = errorsOf(res.body.fields);
      if (section === 'detection') {
        detection = res.body.settings as unknown as DetectionSettings;
        detectionEdit = structuredClone(detection);
        detectionErrors = errs;
      } else {
        image = res.body.settings as unknown as ImageSettings;
        imageEdit = structuredClone(image);
        imageErrors = errs;
      }
      set(res.status === 200 ? 'saved' : 'partial');
    } catch {
      set('error');
    }
  }

  // --- reboot (review focus 4: two explicit clicks) ---
  let confirmReboot = $state(false);
  let rebootState: 'idle' | 'rebooting' | 'done' | 'error' = $state('idle');
  async function reboot() {
    rebootState = 'rebooting';
    const res = await postJson<{ ok?: boolean }>(`/api/cameras/${encodeURIComponent($selectedCameraId!)}/reboot`, { confirm: 'reboot' }).catch(() => null);
    rebootState = res?.status === 200 ? 'done' : 'error';
    confirmReboot = false;
  }

  const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
  const cameraName = $derived($cameras.find((c) => c.id === $selectedCameraId)?.name ?? '');
</script>

<section class="page">
  <h1 data-testid="page-title">Settings</h1>

  <div class="grid">
    <SettingsCard id="prefs" title="App preferences" description="How cams opens for you. Stored with your account.">
      {#if prefs}
        <label>Default camera
          <select data-testid="pref-camera" bind:value={prefs.defaultCamera}>
            <option value={null}>First camera</option>
            {#each $cameras as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
          </select>
        </label>
        <label>Live quality
          <select data-testid="pref-quality" bind:value={prefs.liveQuality}>
            <option value="sub">SD (plays everywhere)</option>
            <option value="main">HD (needs HEVC support)</option>
          </select>
        </label>
        <label>Event filter
          <select data-testid="pref-filter" bind:value={prefs.eventFilter}>
            <option value="all">All</option><option value="person">Person</option><option value="vehicle">Vehicle</option><option value="pet">Pet</option><option value="motion">Motion</option>
          </select>
        </label>
        <label>Timeline zoom
          <select data-testid="pref-zoom" bind:value={prefs.timelineZoom}>
            <option value={24}>24 hours</option><option value={6}>6 hours</option><option value={1}>1 hour</option>
          </select>
        </label>
      {:else}
        <p class="muted">Loading…</p>
      {/if}
      {#snippet footer()}
        <SaveState state={prefsState} />
        <button class="primary" data-testid="save-prefs" disabled={!prefsDirty || prefsState === 'saving'} onclick={savePrefs}>Save</button>
      {/snippet}
    </SettingsCard>

    <SettingsCard id="detection" title="Detection and recording" description={cameraName ? `What ${cameraName} records.` : ''}>
      {#if detectionEdit}
        <label class="row"><input type="checkbox" data-testid="recording-toggle" bind:checked={detectionEdit.recording} /> Recording</label>
        <label class="row">
          <input type="checkbox" data-testid="motion-recording-toggle" checked={detectionEdit.motionRecording === 'on'}
            indeterminate={detectionEdit.motionRecording === 'custom'}
            onchange={(e) => (detectionEdit!.motionRecording = (e.currentTarget as HTMLInputElement).checked ? 'on' : 'off')} />
          Record on motion {#if detectionEdit.motionRecording === 'custom'}<small class="muted">(custom schedule)</small>{/if}
        </label>
        {#if detectionErrors.motionRecording}<span class="err" data-testid="field-error-motionRecording">{detectionErrors.motionRecording}</span>{/if}
        <label>Motion sensitivity <output>{detectionEdit.motionSensitivity}</output>
          <input type="range" min="1" max="50" data-testid="motion-sensitivity" bind:value={detectionEdit.motionSensitivity} />
        </label>
        {#if detectionErrors.motionSensitivity}<span class="err" data-testid="field-error-motionSensitivity">{detectionErrors.motionSensitivity}</span>{/if}
        {#each AI as a (a.kind)}
          <div class="ai">
            <label class="row">
              <input type="checkbox" data-testid={`ai-${a.kind}-record`} checked={detectionEdit.ai[a.kind].record === 'on'}
                indeterminate={detectionEdit.ai[a.kind].record === 'custom'}
                onchange={(e) => (detectionEdit!.ai[a.kind].record = (e.currentTarget as HTMLInputElement).checked ? 'on' : 'off')} />
              Record {a.label.toLowerCase()} {#if detectionEdit.ai[a.kind].record === 'custom'}<small class="muted">(custom schedule)</small>{/if}
            </label>
            <label>{a.label} sensitivity <output>{detectionEdit.ai[a.kind].sensitivity}</output>
              <input type="range" min="0" max="100" data-testid={`ai-${a.kind}-sensitivity`} bind:value={detectionEdit.ai[a.kind].sensitivity} />
            </label>
            {#each [`ai.${a.kind}.record`, `ai.${a.kind}.sensitivity`] as f (f)}
              {#if detectionErrors[f]}<span class="err" data-testid={`field-error-${f}`}>{FIELD_LABELS[f]}: {detectionErrors[f]}</span>{/if}
            {/each}
          </div>
        {/each}
        {#if detectionErrors.recording}<span class="err" data-testid="field-error-recording">{detectionErrors.recording}</span>{/if}
      {:else if loadError}
        <p class="err" role="alert">{loadError}</p>
      {:else}
        <p class="muted">Loading…</p>
      {/if}
      {#snippet footer()}
        <SaveState state={detectionState} />
        <button class="primary" data-testid="save-detection" disabled={!detectionDirty || detectionState === 'saving'} onclick={() => save('detection', detection!, detectionEdit!)}>Save</button>
      {/snippet}
    </SettingsCard>

    <SettingsCard id="image" title="Image and lights">
      {#if imageEdit}
        <label>Day/night
          <select data-testid="daynight-select" bind:value={imageEdit.dayNight}>
            <option value="auto">Automatic</option><option value="color">Always colour</option><option value="blackwhite">Always black and white</option>
          </select>
        </label>
        {#if imageErrors.dayNight}<span class="err" data-testid="field-error-dayNight">{imageErrors.dayNight}</span>{/if}
        <label>Infrared lights
          <select data-testid="ir-select" bind:value={imageEdit.irLights}>
            <option value="auto">Automatic</option><option value="off">Off</option>
          </select>
        </label>
        {#if imageErrors.irLights}<span class="err" data-testid="field-error-irLights">{imageErrors.irLights}</span>{/if}
        <label>Spotlight
          <select data-testid="spotlight-mode" bind:value={imageEdit.spotlight.mode}>
            <option value="off">Off</option><option value="auto">On motion at night</option><option value="night">On all night</option><option value="schedule">On a schedule</option>
          </select>
        </label>
        <label>Spotlight brightness <output>{imageEdit.spotlight.brightness}</output>
          <input type="range" min="0" max="100" data-testid="spotlight-brightness" bind:value={imageEdit.spotlight.brightness} />
        </label>
        {#if imageErrors.spotlight}<span class="err" data-testid="field-error-spotlight">{imageErrors.spotlight}</span>{/if}
        <fieldset>
          <legend>On-screen text</legend>
          <label class="row"><input type="checkbox" data-testid="osd-name-toggle" bind:checked={imageEdit.osd.showName} /> Show camera name</label>
          <label>Name <input data-testid="osd-name" maxlength="31" bind:value={imageEdit.osd.name} /></label>
          <label>Name position
            <select data-testid="osd-name-pos" bind:value={imageEdit.osd.namePosition}>{#each OSD_POSITIONS as p (p)}<option value={p}>{p}</option>{/each}</select>
          </label>
          <label class="row"><input type="checkbox" data-testid="osd-time-toggle" bind:checked={imageEdit.osd.showTime} /> Show date and time</label>
          <label>Time position
            <select data-testid="osd-time-pos" bind:value={imageEdit.osd.timePosition}>{#each OSD_POSITIONS as p (p)}<option value={p}>{p}</option>{/each}</select>
          </label>
          {#if imageErrors.osd}<span class="err" data-testid="field-error-osd">{imageErrors.osd}</span>{/if}
        </fieldset>
      {:else if loadError}
        <p class="err" role="alert">{loadError}</p>
      {:else}
        <p class="muted">Loading…</p>
      {/if}
      {#snippet footer()}
        <SaveState state={imageState} />
        <button class="primary" data-testid="save-image" disabled={!imageDirty || imageState === 'saving'} onclick={() => save('image', image!, imageEdit!)}>Save</button>
      {/snippet}
    </SettingsCard>

    <SettingsCard id="device" title="Device and maintenance">
      {#if device}
        <dl>
          <dt>Model</dt><dd data-testid="device-model">{device.model}</dd>
          <dt>Firmware</dt><dd data-testid="device-firmware">{device.firmware}</dd>
          <dt>Storage</dt>
          <dd data-testid="device-storage">
            {#if device.storage}{gb(device.storage.usedMb)} of {gb(device.storage.totalMb)} used{#if !device.storage.mounted} (not mounted){/if}{:else}No SD card{/if}
          </dd>
          <dt>Certificate</dt>
          <dd data-testid="device-cert">
            {#if device.certificate}
              {device.certificate.subject}, {device.certificate.issuer}, expires {new Date(device.certificate.validTo).toLocaleDateString()} ({device.certificate.daysLeft} days)
            {:else}
              Not available
            {/if}
          </dd>
        </dl>
        <p class="webui">
          <a data-testid="device-webui-link" href={device.webUiUrl} target="_blank" rel="noopener noreferrer">
            Open the camera's own web page <Icon name="external" size={14} />
          </a>
          <small class="muted">Works on the home network only. The camera's page isn't reachable from the internet.</small>
        </p>
      {:else if loadError}
        <p class="err" role="alert">{loadError}</p>
      {:else}
        <p class="muted">Loading…</p>
      {/if}
      {#snippet footer()}
        {#if rebootState === 'done'}<span class="muted" role="status">Rebooting. The camera is back in about a minute.</span>{/if}
        {#if rebootState === 'error'}<span class="err" role="alert">The reboot request failed.</span>{/if}
        {#if confirmReboot}
          <span>Reboot {cameraName}? Recording stops for about a minute.</span>
          <button data-testid="reboot-cancel" onclick={() => (confirmReboot = false)}>Cancel</button>
          <button class="danger" data-testid="reboot-confirm" disabled={rebootState === 'rebooting'} onclick={reboot}>Reboot now</button>
        {:else}
          <button data-testid="reboot-button" disabled={!device} onclick={() => (confirmReboot = true)}><Icon name="power" size={14} /> Reboot camera…</button>
        {/if}
      {/snippet}
    </SettingsCard>
  </div>
</section>

<style>
  .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); align-items: start; }
  label { display: grid; gap: 6px; font-size: 14px; }
  label.row { display: flex; align-items: center; gap: 8px; }
  select, input:not([type='checkbox']):not([type='range']) { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 9px; padding: 6px 10px; }
  input[type='range'] { accent-color: var(--accent); }
  output { color: var(--muted); font-family: var(--mono); font-size: 12px; margin-left: 6px; }
  fieldset { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; display: grid; gap: 10px; }
  legend { padding: 0 6px; color: var(--muted); font-size: 13px; }
  .ai { display: grid; gap: 8px; padding-top: 6px; border-top: 1px dashed var(--border); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; font-size: 14px; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .webui { display: grid; gap: 4px; margin: 0; }
  .webui a { display: inline-flex; align-items: center; gap: 6px; color: var(--accent); }
  .muted { color: var(--muted); }
  .err { color: var(--danger); font-size: 13px; }
  button { font: inherit; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  button:disabled { opacity: 0.45; cursor: default; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  button.danger { background: var(--danger); color: #fff; border-color: transparent; }
</style>
```

- [ ] **Step 5: The camera web UI link in the top bar.** In `web/src/components/TopBar.svelte`, right after `<CameraPicker …/>`:

```svelte
  {#if selected?.webUiUrl}
    <a class="webui" data-testid="camera-webui-link" href={selected.webUiUrl} target="_blank" rel="noopener noreferrer"
      title="Opens the camera's own web page. Works on the home network only." aria-label="Camera web UI (home network only)">
      <Icon name="external" size={16} />
    </a>
  {/if}
```

Here `const selected = $derived($cameras.find((c) => c.id === $selectedCameraId));`. Style it like the other 36 px icon buttons in the top bar. Keep it visible on phones; it is only an icon.

Add to `ICONS` in `web/src/lib/icons.ts`:

```ts
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
```

- [ ] **Step 6: Apply preferences.**
- **`web/src/App.svelte`:** in `load()`, fetch preferences in parallel: `const [profile, list, prefs] = await Promise.all([…, loadPreferences()])`. Then select `(list.some(c=>c.id===id) ? id : (prefs?.defaultCamera && list.some(c=>c.id===prefs.defaultCamera) ? prefs.defaultCamera : list[0]?.id ?? null))`.
- **`web/src/pages/Live.svelte`:** `initialQuality()` returns the stored localStorage value if present; otherwise `pref('liveQuality') ?? 'sub'`.
- **`web/src/pages/Recordings.svelte`:** when the URL has no `filter` param, use `pref('eventFilter') ?? 'all'`. `parseCursor` already falls back to `'all'`; override that only when `!$route.params.has('filter')`.
- **`web/src/components/Timeline.svelte`:** `let zoom: Zoom = $state(pref('timelineZoom') ?? 24);`

- [ ] **Step 7: The About page (replace `web/src/pages/About.svelte`)**

```svelte
<script lang="ts">
  import { cameras, me } from '../lib/stores';
  import { getJson } from '../lib/api';
  import { LICENCES } from '../lib/licences';
  import type { DeviceInfo } from '../lib/settings';

  let devices: Record<string, DeviceInfo | 'offline'> = $state({});
  $effect(() => {
    for (const c of $cameras) {
      if (devices[c.id]) continue;
      getJson<DeviceInfo>(`/api/cameras/${encodeURIComponent(c.id)}/device`)
        .then((d) => (devices = { ...devices, [c.id]: d }))
        .catch(() => (devices = { ...devices, [c.id]: 'offline' }));
    }
  });
  const built = $derived($me?.buildDate ? new Date($me.buildDate).toLocaleString() : 'not recorded (local build)');
  const version = $derived($me?.version ?? '…');
  const release = $derived(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(version) ? `https://github.com/klaushofrichter/cams/releases/tag/v${version}` : 'https://github.com/klaushofrichter/cams');
</script>

<section class="page">
  <h1 data-testid="page-title">About</h1>
  <div class="cards">
    <div class="card">
      <p><strong>cams</strong> by <a href="https://skylar.technology" target="_blank" rel="noopener noreferrer">Skylar Technology LLC</a>: a private viewer for our Reolink security cameras.</p>
      <dl>
        <dt>Version</dt><dd><a data-testid="about-version" href={release} target="_blank" rel="noopener noreferrer">{version}</a></dd>
        <dt>Built</dt><dd data-testid="about-build">{built}</dd>
        <dt>Source</dt><dd><a href="https://github.com/klaushofrichter/cams" target="_blank" rel="noopener noreferrer">github.com/klaushofrichter/cams</a></dd>
      </dl>
    </div>
    <div class="card">
      <h2>Supported cameras</h2>
      <ul data-testid="about-cameras">
        {#each $cameras as c (c.id)}
          {@const d = devices[c.id]}
          <li><strong>{c.name}</strong>: {#if d === 'offline'}offline{:else if d}{d.model}, firmware {d.firmware}{:else}…{/if}</li>
        {/each}
      </ul>
      <p class="muted">Tested with the Reolink RLC-1224A on firmware v3.2.0.6011. How its API behaves is documented in <a href="https://github.com/klaushofrichter/cams/blob/main/docs/reolink-api.md" target="_blank" rel="noopener noreferrer">docs/reolink-api.md</a>.</p>
    </div>
    <div class="card">
      <h2>Credits and licences</h2>
      <ul data-testid="about-licences">
        {#each LICENCES as l (l.name)}
          <li><a href={l.url} target="_blank" rel="noopener noreferrer">{l.name}</a>: {l.licence}, {l.use}</li>
        {/each}
      </ul>
      <p class="muted">Reolink is a trademark of its owner. cams is not affiliated with Reolink.</p>
    </div>
  </div>
</section>

<style>
  .cards { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); align-items: start; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; }
  h2 { margin: 0 0 10px; font-size: 16px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 12px 0 0; }
  dt { color: var(--muted); }
  dd { margin: 0; }
  ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
  .muted { color: var(--muted); font-size: 13px; }
  a { color: var(--accent); }
</style>
```

- [ ] **Step 8: Verify and commit.**
  - Run `npx vitest run`.
  - Run `npm run build`. There must be no Svelte warnings; fix any the compiler reports without changing behaviour or test ids, and list them in the report.
  - Run `npm run check`.
  - Run `npm run test:e2e`. The existing tests must stay green. The About page's old `about-version` test may need its selector adjusted, because the version is now a link.

```bash
git add web
git commit -m "feat: Settings cards, About page and LAN-only camera web UI link"
```

---

### Task 7: e2e for Settings, About and the link

**Files:**
- Create: `e2e/settings.spec.ts`
- Modify: `e2e/cameras.json` (only if a failure-injecting camera is needed; see below), `playwright.config.ts` (a second mock camera, if needed)

The e2e mock runs from `test/mock-camera/cli.ts` on port 8098 with default options. To show the error state without a second mock, add CLI env options to `cli.ts`:
- `MOCK_SETTINGS_FAILURES`, a comma list
- `MOCK_IGNORE_WRITES`

Start a **second** mock on port 8097 with `MOCK_SETTINGS_FAILURES=SetWhiteLed` as another `webServer` entry, and point the **Porch** camera at it in `e2e/cameras.json` (`127.0.0.1:8097`). Porch keeps serving live video and recordings from its own mock. Check that no existing e2e test depends on Porch sharing cam1's mock state. The Plan 3 tests only need Porch to have the default clips, which the second mock also serves.

- [ ] **Step 1: `e2e/settings.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import { signIn } from './session';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

test('settings cards load the camera state', async ({ page }) => {
  await page.goto('/app/settings');
  await expect(page.getByTestId('settings-card-detection')).toBeVisible();
  await expect(page.getByTestId('recording-toggle')).toBeChecked();
  await expect(page.getByTestId('osd-name')).toHaveValue('Den');
  await expect(page.getByTestId('device-model')).toHaveText('RLC-1224A');
  await expect(page.getByTestId('device-storage')).toContainText('of 59.6 GB used');
});

test('saving a camera setting shows the success state and persists', async ({ page }) => {
  await page.goto('/app/settings');
  const name = page.getByTestId('osd-name');
  await name.fill(`Den ${Date.now() % 1000}`);
  const value = await name.inputValue();
  await page.getByTestId('save-image').click();
  await expect(page.getByTestId('settings-card-image').getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await page.reload();
  await expect(page.getByTestId('osd-name')).toHaveValue(value);
  // restore, so other tests see the default name
  await page.getByTestId('osd-name').fill('Den');
  await page.getByTestId('save-image').click();
  await expect(page.getByTestId('settings-card-image').getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
});

test('a rejected field shows the error next to it while the others save', async ({ page }) => {
  await page.goto('/app/settings');
  await page.getByTestId('camera-picker').selectOption({ label: 'Porch' });
  await expect(page.getByTestId('spotlight-mode')).toBeVisible();
  await page.getByTestId('spotlight-mode').selectOption('off');
  await page.getByTestId('daynight-select').selectOption('color');
  await page.getByTestId('save-image').click();
  const card = page.getByTestId('settings-card-image');
  await expect(card.getByTestId('save-state')).toHaveAttribute('data-state', 'partial');
  await expect(card.getByTestId('field-error-spotlight')).toBeVisible();
  await expect(page.getByTestId('daynight-select')).toHaveValue('color');
  // restore
  await page.getByTestId('daynight-select').selectOption('auto');
  await page.getByTestId('save-image').click();
});

test('an offline camera shows a clear message instead of a spinner', async ({ page }) => {
  await page.goto('/app/settings');
  await page.getByTestId('camera-picker').selectOption({ label: 'Garage' });
  await expect(page.getByTestId('settings-card-detection').getByRole('alert')).toContainText('could not be loaded');
});

test('reboot needs a second click and can be cancelled', async ({ page }) => {
  await page.goto('/app/settings');
  await page.getByTestId('reboot-button').click();
  await expect(page.getByTestId('reboot-confirm')).toBeVisible();
  await page.getByTestId('reboot-cancel').click();
  await expect(page.getByTestId('reboot-confirm')).toHaveCount(0);
  const state = await (await page.request.get('http://127.0.0.1:8098/__state')).json();
  expect(state.reboots).toBe(0);
});

test('preferences save and apply', async ({ page }) => {
  await page.goto('/app/settings');
  await page.getByTestId('pref-zoom').selectOption('6');
  await page.getByTestId('save-prefs').click();
  await expect(page.getByTestId('settings-card-prefs').getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await page.goto('/app/recordings?panel=history');
  await expect(page.getByTestId('zoom-6')).toHaveAttribute('aria-pressed', 'true');
  // restore
  await page.goto('/app/settings');
  await page.getByTestId('pref-zoom').selectOption('24');
  await page.getByTestId('save-prefs').click();
  await expect(page.getByTestId('settings-card-prefs').getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
});

test('the camera web UI link points at the LAN address and says it is home-network only', async ({ page }) => {
  await page.goto('/app/live');
  const link = page.getByTestId('camera-webui-link');
  await expect(link).toHaveAttribute('href', 'https://127.0.0.1/');
  await expect(link).toHaveAttribute('title', /home network only/);
  await expect(link).toHaveAttribute('target', '_blank');
  await page.goto('/app/settings');
  await expect(page.getByTestId('device-webui-link')).toHaveAttribute('href', 'https://127.0.0.1/');
  await expect(page.getByTestId('settings-card-device')).toContainText("isn't reachable from the internet");
});

test('about shows version, build, cameras and licences', async ({ page }) => {
  await page.goto('/app/about');
  await expect(page.getByTestId('about-version')).toBeVisible();
  await expect(page.getByTestId('about-build')).toBeVisible();
  await expect(page.getByTestId('about-cameras')).toContainText('RLC-1224A');
  await expect(page.getByTestId('about-cameras')).toContainText('Garage: offline');
  await expect(page.getByTestId('about-licences')).toContainText('mpegts.js');
});
```

Adapt `camera-picker` to the picker's real test id (check `CameraPicker.svelte`). The storage text follows from the mock: 61047 MB total is 59.6 GB. If the phone project hides the picker or the link, the test must handle the phone layout rather than skip it. Tests that change camera state restore it, because the mock's state lives as long as the e2e run.

The e2e env sets `PREFS_FILE`: add `PREFS_FILE: '/tmp/cams-e2e-prefs.json'` in `e2e/env.ts`, and delete that file in Playwright's global setup if one exists; otherwise at the start of this spec file with `fs.rmSync(..., {force:true})`. Tests run in parallel across projects and could race on the one preferences file. The preferences test must therefore run only in the `desktop` project (`test.skip(testInfo.project.name !== 'desktop', 'one shared preferences file')`) or use `test.describe.configure({ mode: 'serial' })`. Choose and explain your choice.

- [ ] **Step 2: Run the suite.** `npm run build && npm run test:e2e` must be green on every project, twice. Also run `npx vitest run`. Ports 8097–8099 must be free afterwards.

- [ ] **Step 3: Commit**

```bash
git add e2e test/mock-camera/cli.ts playwright.config.ts
git commit -m "test: e2e for settings save/partial/offline, reboot guard, preferences, about and the web UI link"
```

---

### Task 8 (controller, ops): data volume, ship, verify

- [ ] **Step 1: Ask kube-setup** to add a PVC `cams-data` (64Mi) to the cams ksvc:
  - mounted at `/var/lib/cams`, writable by uid 1000 (it is empty on first use);
  - `PREFS_FILE=/var/lib/cams/preferences.json`;
  - kube-setup should push to git before applying.

  Also ask whether Knative allows PVC volumes (the `kubernetes.podspec-persistent-volume-claim` flag). If it doesn't, the fallback is to keep preferences in the emptyDir cache dir. They would be lost on restart, so the Preferences card would say so.
- [ ] **Step 2: Gate and ship.** Run the full local gate. Then:
  1. Open a PR from the branch to `main`, and wait for green CI.
  2. Open a PR from `main` to `production`, and wait for green CI.
  3. Watch the deploy.
- [ ] **Step 3: Verify on the real camera, read-only first.**
  - Open Settings. Detection must show recording on, motion sensitivity 41, and people sensitivity 60.
  - Device must show the certificate for `cam1.skylar.technology` with its expiry.
  - Klaus then changes one harmless setting, the OSD position, saves it, sees "Saved", and changes it back.
  - **No reboot** unless Klaus asks for one.
- [ ] **Step 4: Records.**
  - Update `docs/reolink-api.md` with a new "Settings" section built from this plan's camera facts table. Include the partial-param writes, the `sensDef` inversion, `size` meaning free space, and the -56/-67 rejections.
  - Update the Obsidian note to match.
  - Correct the Plan 3 note that said the AI record schedule was off. It is fully on; the clips are simply motion-only so far.
  - Write the follow-ups to `docs/superpowers/plans/2026-09-26-cams-4-followups.md`.
