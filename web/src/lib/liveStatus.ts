import { writable } from 'svelte/store';

export type IndicatorState = 'streaming' | 'error' | 'idle';
export interface LiveStatus {
  state: IndicatorState;
  cameraName: string | null;
  detail: string;
}

const IDLE: LiveStatus = { state: 'idle', cameraName: null, detail: 'No live video' };
export const liveStatus = writable<LiveStatus>(IDLE);

// "Streaming" means a live picture is actually playing (on the Live page or
// kept alive in the background); "error" means the camera is offline or the
// stream dropped and is reconnecting. A first connect is neither.
export function deriveStatus(i: {
  mounted: boolean;
  cameraName: string | null;
  online: boolean | null;
  offlineReason: string | null;
  player: 'connecting' | 'playing' | 'reconnecting' | null;
}): LiveStatus {
  if (!i.mounted || !i.cameraName) return IDLE;
  const name = i.cameraName;
  if (i.online === false) return { state: 'error', cameraName: name, detail: `${name}: offline. ${i.offlineReason ?? ''}`.trim() };
  if (i.player === 'playing') return { state: 'streaming', cameraName: name, detail: `${name}: live video is streaming` };
  if (i.player === 'reconnecting') return { state: 'error', cameraName: name, detail: `${name}: connection lost, reconnecting…` };
  return { state: 'idle', cameraName: name, detail: `${name}: connecting…` };
}

const FRAME: Record<IndicatorState, string | null> = { streaming: '#22C55E', error: '#EF4444', idle: null };

// The app icon (web/public/favicon.svg), inset so a frame fits around it.
export function faviconSvg(state: IndicatorState): string {
  const frame = FRAME[state];
  const icon =
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22D3EE"/><stop offset="1" stop-color="#6366F1"/></linearGradient></defs>' +
    '<rect x="6" y="6" width="52" height="52" rx="13" fill="url(#g)"/>' +
    '<circle cx="32" cy="32" r="14" fill="#0B1220"/>' +
    '<circle cx="32" cy="32" r="7.4" fill="none" stroke="#22D3EE" stroke-width="2.5"/>' +
    '<circle cx="35.3" cy="28.7" r="2.1" fill="#E6EDF7"/>';
  const ring = frame ? `<rect x="2" y="2" width="60" height="60" rx="16" fill="none" stroke="${frame}" stroke-width="4"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${icon}${ring}</svg>`;
}

export function documentTitle(s: LiveStatus): string {
  if (s.state === 'streaming' && s.cameraName) return `● Live · ${s.cameraName} · cams`;
  if (s.state === 'error' && s.cameraName) return `⚠ ${s.cameraName} · cams`;
  return 'cams · Skylar Technology';
}
