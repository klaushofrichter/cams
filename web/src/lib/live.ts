export type Quality = 'sub' | 'main';

// Knative cuts a response at 600 s; the player moves to a fresh connection
// well before that so the cut is never visible.
export const SWAP_AFTER_MS = 9 * 60 * 1000;
export const STANDBY_RETRY_MS = 5_000;
export const QUALITY_KEY = 'cams-live-quality';

export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

// The main stream is H.265; only offer it where the browser can decode it.
export function supportsHevc(isTypeSupported: (type: string) => boolean): boolean {
  return isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.90"');
}

// What a browser may play of a cam-proxy's live stream (fMP4): passed to the
// proxy (and on to go2rtc), so main H.265 comes only where it plays.
export const CODEC_CANDIDATES = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'mp4a.40.2'];

export function browserCodecs(isTypeSupported: (type: string) => boolean): string {
  return CODEC_CANDIDATES.filter((c) => isTypeSupported(`video/mp4; codecs="${c}"`)).join(',');
}

export function liveUrl(cameraId: string, quality: Quality, codecs?: string): string {
  return `/api/cameras/${encodeURIComponent(cameraId)}/live?quality=${quality}${codecs ? `&codecs=${encodeURIComponent(codecs)}` : ''}`;
}

export function snapshotUrl(cameraId: string): string {
  return `/api/cameras/${encodeURIComponent(cameraId)}/snapshot.jpg`;
}
