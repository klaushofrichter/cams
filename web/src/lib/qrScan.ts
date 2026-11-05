// The /token page's QR scanner (cams-admin design 2026-11-05 §9.2): the
// device camera (rear camera preferred) through getUserMedia, read with the
// browser's BarcodeDetector where it has one for QR codes, else with jsQR
// (iOS Safari has no BarcodeDetector), loaded only when needed. Only on a
// secure page: browsers give no camera to plain http (the Pi's LAN address),
// where the page offers paste only. Nothing leaves the device: frames are
// read in the page and dropped.

export type FrameDecoder = (video: HTMLVideoElement) => Promise<string | null>;

interface Detector { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> }
interface DetectorClass { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> }

export function scannerAvailable(win: Window & typeof globalThis = window): boolean {
  return win.isSecureContext === true && typeof win.navigator?.mediaDevices?.getUserMedia === 'function';
}

// RGBA pixels → the QR code's text (jsQR), or null.
export async function decodeRgba(data: Uint8ClampedArray, width: number, height: number): Promise<string | null> {
  const { default: jsQR } = await import('jsqr');
  return jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

// The browser's detector when it reads QR codes, else jsQR on a canvas copy
// of the frame (at most 640 px wide).
export async function frameDecoder(win: Window & typeof globalThis = window): Promise<FrameDecoder> {
  const Cls = (win as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
  if (Cls) {
    try {
      const formats = Cls.getSupportedFormats ? await Cls.getSupportedFormats() : ['qr_code'];
      if (formats.includes('qr_code')) {
        const detector = new Cls({ formats: ['qr_code'] });
        return async (video) => (await detector.detect(video).catch(() => []))[0]?.rawValue ?? null;
      }
    } catch {
      // fall through to jsQR
    }
  }
  const canvas = win.document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    if (!ctx || !video.videoWidth || !video.videoHeight) return null;
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return decodeRgba(img.data, img.width, img.height);
  };
}

export interface Scan { stop(): void }

// Starts the camera into `video` and reads a frame every 200 ms until
// `onText` returns true (or stop()). Throws when there is no camera or the
// person said no.
export async function startScan(video: HTMLVideoElement, onText: (text: string) => boolean, win: Window & typeof globalThis = window): Promise<Scan> {
  const stream = await win.navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  try {
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    stop();
    throw err;
  }
  const decode = await frameDecoder(win);
  const tick = async () => {
    if (stopped) return;
    const text = video.readyState >= 2 ? await decode(video).catch(() => null) : null;
    if (stopped) return;
    if (text && onText(text)) return stop();
    timer = setTimeout(() => void tick(), 200);
  };
  void tick();
  return { stop };
}
