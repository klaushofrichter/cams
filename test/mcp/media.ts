// Real JPEGs for the MCP image tests (ffmpeg's test pattern).
import { spawnSync } from 'child_process';

export function testJpeg(width: number, height: number): Buffer {
  const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=1`, '-frames:v', '1', '-q:v', '2', '-f', 'mjpeg', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('ffmpeg failed to make a test JPEG');
  return r.stdout;
}

// Width and height from a JPEG's SOF marker.
export function jpegSize(b: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('no SOF');
}
