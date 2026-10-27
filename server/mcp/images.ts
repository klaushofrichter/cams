// Images for the model (spec 2026-10-27-mcp-server-design §4): ffmpeg scales
// to a width (never up), JPEG -q:v 5; over 400 KB it tries once at -q:v 12,
// else image_too_large. Two ffmpeg processes at a time, one thread each.
import { spawn } from 'child_process';
import { Semaphore } from '../reolink/semaphore';
import { ToolFailure } from './result';

export const MAX_IMAGE_BYTES = 400 * 1024;
export const MAX_RESULT_IMAGE_BYTES = 1200 * 1024;
export const MAX_IMAGES = 4;
const MAX_INPUT = 32 * 1024 * 1024;
const gate = new Semaphore(2);

function run(input: Buffer, width: number, q: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-threads', '1', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', String(q), '-f', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => ff.kill('SIGKILL'), 15_000);
    ff.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_INPUT) ff.kill('SIGKILL');
      else out.push(d);
    });
    ff.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && size > 0 && size <= MAX_INPUT) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited with ${code}`));
    });
    ff.stdin.on('error', () => undefined); // ffmpeg may stop reading early
    ff.stdin.end(input);
  });
}

// Width from a JPEG's SOF marker; null when there is none.
export function jpegWidth(b: Buffer): number | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return b.readUInt16BE(i + 7);
    i += 2 + len;
  }
  return null;
}

export async function scaleJpeg(input: Buffer, maxWidth: number): Promise<{ data: Buffer; width: number }> {
  if (input.length > MAX_INPUT) throw new ToolFailure('image_too_large');
  return gate.run(async () => {
    let data: Buffer;
    try {
      data = await run(input, maxWidth, 5);
      if (data.length > MAX_IMAGE_BYTES) data = await run(input, maxWidth, 12);
    } catch {
      throw new ToolFailure('not_found', 'The picture could not be read.');
    }
    if (data.length > MAX_IMAGE_BYTES) throw new ToolFailure('image_too_large');
    const width = jpegWidth(data);
    if (width === null) throw new ToolFailure('not_found', 'The picture could not be read.');
    return { data, width };
  });
}
