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

// The firmware stores the OSD name in 32 bytes (31 plus the terminator), so
// the limit is UTF-8 bytes, not characters. \p{C} covers control and format
// characters: C0/C1, bidi overrides and zero-width characters, none of which
// belong in text burned into the video.
export const OSD_NAME_MAX_BYTES = 31;
export function validOsdName(name: unknown): name is string {
  return typeof name === 'string' && Buffer.byteLength(name, 'utf8') <= OSD_NAME_MAX_BYTES && !/\p{C}/u.test(name) && /\S/u.test(name);
}

export function validateImagePatch(body: unknown): { ok: true; patch: ImagePatch } | { ok: false; details: string[] } {
  if (!isObj(body)) return { ok: false, details: ['body must be an object'] };
  const b = body as Obj;
  const details: string[] = [];
  onlyKeys(b, ['dayNight', 'irLights', 'spotlight', 'osd'], '', details);
  // Own keys only: `in` would accept inherited names such as 'toString'.
  if ('dayNight' in b && !Object.keys(DAYNIGHT).includes(b.dayNight as string)) details.push('dayNight: auto, color or blackwhite');
  if ('irLights' in b && !Object.keys(IR).includes(b.irLights as string)) details.push('irLights: auto or off');
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
      if ('name' in o && !validOsdName(o.name)) details.push('osd.name: up to 31 bytes (UTF-8), not blank, no control or invisible characters');
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

// The untouched half of SetWhiteLed and SetOsd comes from the RAW Get replies,
// not from imageFrom(): that normalizes values it doesn't know (a custom OSD
// position, a newer spotlight mode, a missing brightness), and writing the
// normalized value back would change a setting the user never touched.
// Keys the camera didn't report are left out: the firmware merges partial
// params, so an absent key stays as it is.
function pick(o: Obj, keys: string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export function imageCommands(p: ImagePatch, raw: { wl: unknown; osd: unknown }): SettingsCommand[] {
  const out: SettingsCommand[] = [];
  if (p.dayNight) out.push({ field: 'dayNight', cmd: 'SetIsp', param: { Isp: { channel: 0, dayNight: DAYNIGHT[p.dayNight] } } });
  if (p.irLights) out.push({ field: 'irLights', cmd: 'SetIrLights', param: { IrLights: { channel: 0, state: IR[p.irLights] } } });
  if (p.spotlight && Object.keys(p.spotlight).length) {
    const s = p.spotlight;
    const wl = { ...pick(obj(obj(raw.wl).WhiteLed), ['mode', 'bright']) };
    if (s.mode !== undefined) wl.mode = SPOTLIGHT_MODES.indexOf(s.mode);
    if (s.brightness !== undefined) wl.bright = s.brightness;
    out.push({ field: 'spotlight', cmd: 'SetWhiteLed', param: { WhiteLed: { channel: 0, ...wl } } });
  }
  if (p.osd && Object.keys(p.osd).length) {
    const o = p.osd;
    const osd = obj(obj(raw.osd).Osd);
    const ch = pick(obj(osd.osdChannel), ['enable', 'name', 'pos']);
    const time = pick(obj(osd.osdTime), ['enable', 'pos']);
    if (o.showName !== undefined) ch.enable = o.showName ? 1 : 0;
    if (o.name !== undefined) ch.name = o.name;
    if (o.namePosition !== undefined) ch.pos = o.namePosition;
    if (o.showTime !== undefined) time.enable = o.showTime ? 1 : 0;
    if (o.timePosition !== undefined) time.pos = o.timePosition;
    out.push({ field: 'osd', cmd: 'SetOsd', param: { Osd: { channel: 0, osdChannel: ch, osdTime: time } } });
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
