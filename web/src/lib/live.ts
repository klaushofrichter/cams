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

export function liveUrl(cameraId: string, quality: Quality): string {
  return `/api/cameras/${encodeURIComponent(cameraId)}/live?quality=${quality}`;
}

export function snapshotUrl(cameraId: string): string {
  return `/api/cameras/${encodeURIComponent(cameraId)}/snapshot.jpg`;
}
