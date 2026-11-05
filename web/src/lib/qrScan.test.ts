// The scanner's jsQR path (the one iOS Safari takes) on a real QR code: the
// fixture is a version-4 code (level M) of an e2e sign-in link, drawn as
// pixels the way a camera frame arrives (4 px a module, quiet zone 4).
import { describe, expect, it } from 'vitest';
import qr from '../../../test/fixtures/viewer-token-qr.json';
import { decodeRgba, scannerAvailable } from './qrScan';

function draw(rows: string[], px = 4, quiet = 4, invert = false): { data: Uint8ClampedArray; size: number } {
  const n = rows.length + 2 * quiet;
  const size = n * px;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.floor(y / px) - quiet, c = Math.floor(x / px) - quiet;
      const dark = r >= 0 && c >= 0 && r < rows.length && c < rows.length && rows[r][c] === '1';
      const v = dark !== invert ? 0 : 255;
      data.set([v, v, v, 255], (y * size + x) * 4);
    }
  }
  return { data, size };
}

describe('decodeRgba (jsQR)', () => {
  it('reads the sign-in link from the code', async () => {
    const { data, size } = draw(qr.rows);
    expect(await decodeRgba(data, size, size)).toBe(qr.text);
  });

  it('a frame without a code: null', async () => {
    const size = 64;
    expect(await decodeRgba(new Uint8ClampedArray(size * size * 4).fill(255), size, size)).toBeNull();
  });
});

describe('scannerAvailable', () => {
  const win = (secure: boolean, gum: boolean) => ({ isSecureContext: secure, navigator: { mediaDevices: gum ? { getUserMedia: () => undefined } : undefined } }) as unknown as Window & typeof globalThis;
  it('only on a secure page with a camera API (never plain http)', () => {
    expect(scannerAvailable(win(true, true))).toBe(true);
    expect(scannerAvailable(win(false, true))).toBe(false);
    expect(scannerAvailable(win(true, false))).toBe(false);
  });
});
