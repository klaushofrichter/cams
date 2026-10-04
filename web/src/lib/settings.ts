import { apiFetch } from './api';

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
  flip: { vertical: boolean; mirror: boolean }; // Isp.rotation / Isp.mirroring
  osd: { showName: boolean; name: string; namePosition: string; showTime: boolean; timePosition: string; watermark: boolean };
}
export interface DeviceInfo {
  model: string;
  firmware: string;
  hardware: string;
  name: string;
  storage: { totalMb: number; usedMb: number; mounted: boolean } | null;
  certificate: { subject: string; issuer: string; validTo: string; daysLeft: number } | null;
  webUiUrl: string | null;
  webUiNote?: string;
}
export interface SaveResult<T> {
  fields: Record<string, { ok: boolean; error?: string }>;
  settings: T;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// Only these keys carry a Schedule ('on' | 'off' | 'custom'). The server
// rejects 'custom' as a value there, and an untouched custom schedule must
// never be overwritten -- but 'custom' is an ordinary string elsewhere (for
// example a user naming their OSD text "custom"), and must not be dropped.
const SCHEDULE_KEYS = new Set(['motionRecording', 'record']);

// Changed leaves only, as a deep partial.
export function diffPatch<T extends object>(original: T, edited: T): Partial<T> {
  const out: Obj = {};
  for (const [k, v] of Object.entries(edited as Obj)) {
    const was = (original as Obj)[k];
    if (isObj(v) && isObj(was)) {
      const inner = diffPatch(was, v);
      if (Object.keys(inner).length) out[k] = inner;
    } else if (Array.isArray(v) && Array.isArray(was)) {
      // A list is one value: sent whole when it differs (by content, not identity).
      if (JSON.stringify(v) !== JSON.stringify(was)) out[k] = v;
    } else if (v !== was) {
      if (v === 'custom' && SCHEDULE_KEYS.has(k)) continue;
      out[k] = v;
    }
  }
  return out as Partial<T>;
}

// Through apiFetch like getJson (see api.ts), so an expired session is
// handled the same way for PUT and POST.
async function bodyJson<T>(method: 'PUT' | 'POST', url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await apiFetch(url, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

export function putJson<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  return bodyJson<T>('PUT', url, body);
}

export function postJson<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  return bodyJson<T>('POST', url, body);
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
  flip: 'Picture orientation',
  osd: 'On-screen text',
};
