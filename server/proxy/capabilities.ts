import type { ProxyCameraEntry } from './cameraList';

// What a camera can do, as its cam-proxy reports it in GET /api/cameras
// (cam-proxy spec 2026-10-30-ptz-capabilities-design §4). Only what cams
// knows is kept; anything odd reads as "nothing extra" (null).

export interface PtzCapabilities {
  move: boolean;
  zoom: boolean;
  focus: boolean;
  speed: boolean;
  positions: { max: number } | null; // null: the camera can't store positions
}

export interface Capabilities {
  schema: 1;
  ptz: PtzCapabilities | null; // null: no pan/tilt control (or a proxy without the PTZ API)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// null while the proxy doesn't know (the camera was never read) or says
// nothing usable. `ptz` counts only when the proxy lists the `ptz` feature
// (it then speaks the PTZ API at all).
export function parseCapabilities(entry: ProxyCameraEntry | undefined): Capabilities | null {
  const caps = entry?.capabilities;
  if (!isObject(caps) || typeof caps.schema !== 'number' || !(caps.schema >= 1)) return null;
  const speaksPtz = Array.isArray(entry?.features) && entry.features.includes('ptz');
  if (!speaksPtz || !isObject(caps.ptz)) return { schema: 1, ptz: null };
  const p = caps.ptz;
  const max = isObject(p.positions) ? p.positions.max : undefined;
  return {
    schema: 1,
    ptz: {
      move: p.move === true,
      zoom: p.zoom === true,
      focus: p.focus === true,
      speed: p.speed === true,
      positions: typeof max === 'number' && Number.isInteger(max) && max >= 1 && max <= 64 ? { max } : null,
    },
  };
}
