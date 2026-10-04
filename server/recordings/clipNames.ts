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
  // When DST is in effect (GetTime's Dst rule; cam-sim mirrors the camera's
  // US rule): a month, its week (1-4, 5 = the last), weekday (0 = Sunday)
  // and the local time in minutes, standard time at the start, daylight time
  // at the end. Missing when the camera gave no rule.
  dstRule?: { start: DstEdge; end: DstEdge };
}
export interface DstEdge { mon: number; week: number; weekday: number; minutes: number }

export const CLIP_ID = /^\d{8}-\d{6}-\d{6}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

// YYYYMMDD… (a clip id, or a file name's date) → YYYY-MM-DD.
export function clipDate(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// The regex lets through calendar nonsense like 2026-13-40 or 2026-02-30;
// this rejects that by round-tripping through UTC Date and checking the
// components survived unchanged.
export function isRealDate(date: string): boolean {
  if (!DATE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

export function isRealMonth(month: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(month)) return false;
  const mon = Number(month.slice(5, 7));
  return mon >= 1 && mon <= 12;
}

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
    date: clipDate(ymd),
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
  const v = (value ?? {}) as { Time?: { timeZone?: number }; Dst?: Record<string, unknown> & { enable?: number; offset?: number } };
  const west = Number(v.Time?.timeZone ?? 0);
  const dstOn = Number(v.Dst?.enable ?? 0) === 1;
  const edge = (k: 'start' | 'end'): DstEdge | null => {
    const n = (f: string) => Number(v.Dst?.[`${k}${f}`]);
    const e = { mon: n('Mon'), week: n('Week'), weekday: n('Weekday'), minutes: n('Hour') * 60 + (Number.isFinite(n('Min')) ? n('Min') : 0) };
    const ok = Number.isInteger(e.mon) && e.mon >= 1 && e.mon <= 12 && Number.isInteger(e.week) && e.week >= 1 && e.week <= 5 && Number.isInteger(e.weekday) && e.weekday >= 0 && e.weekday <= 6 && Number.isFinite(e.minutes);
    return ok ? e : null;
  };
  const start = edge('start'), end = edge('end');
  return {
    stdOffsetMinutes: west === 0 ? 0 : -west / 60,
    dstOffsetMinutes: dstOn ? Number(v.Dst?.offset ?? 1) * 60 : 0,
    ...(dstOn && start && end ? { dstRule: { start, end } } : {}),
  };
}

// The day of month of a rule's edge in `year`: the week-th weekday of the
// month, week 5 the last one.
function edgeDay(year: number, e: DstEdge): number {
  const first = new Date(Date.UTC(year, e.mon - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, e.mon, 0)).getUTCDate();
  let day = 1 + ((e.weekday - first + 7) % 7) + (Math.min(e.week, 5) - 1) * 7;
  while (day > days) day -= 7;
  return day;
}

// The camera's UTC offset in minutes in effect at `at` (review of #190: DST
// enabled is not DST in effect). The camera's rule when it gave one; else the
// viewer's zone (`zone`) when its offset at `at` is one the camera can have;
// else standard time.
export function offsetAt(t: TimeInfo, at: number, zone?: string): number {
  const std = t.stdOffsetMinutes, dst = t.dstOffsetMinutes;
  if (!dst) return std;
  if (t.dstRule) {
    // Both edges on the standard-time clock: the end is given in daylight time.
    const local = at + std * 60_000;
    const year = new Date(local).getUTCFullYear();
    const instant = (e: DstEdge, shift: number) => Date.UTC(year, e.mon - 1, edgeDay(year, e)) + (e.minutes - shift) * 60_000;
    const start = instant(t.dstRule.start, 0), end = instant(t.dstRule.end, dst);
    const on = start < end ? local >= start && local < end : local >= start || local < end; // southern summers span the new year
    return std + (on ? dst : 0);
  }
  const viewer = zone ? zoneOffset(at, zone) : null;
  return viewer === std || viewer === std + dst ? viewer : std;
}

// A zone's UTC offset in minutes at `at`, or null for an unknown zone.
function zoneOffset(at: number, zone: string): number | null {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, Number(x.value)]));
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000) / 60_000);
  } catch {
    return null;
  }
}

// YYYY-MM-DD_HH-MM-SS of `at` at a UTC offset in minutes, or in a zone.
export const offsetStamp = (at: number, offMin: number): string => new Date(at + offMin * 60_000).toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
export function zoneStamp(at: number, zone: string): string {
  return offsetStamp(at, zoneOffset(at, zone) ?? 0);
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

// A clip id's length in seconds (YYYYMMDD-HHMMSS-HHMMSS, camera-local wall
// times; an end before the start is past midnight), as clipTimes counts it.
export function clipSeconds(id: string): number {
  const d = seconds(id.slice(16, 22)) - seconds(id.slice(9, 15));
  return d < 0 ? d + 86400 : d;
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
