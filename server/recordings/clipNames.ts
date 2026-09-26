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
