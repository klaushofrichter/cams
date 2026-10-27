// Images for the model (spec §4): scaled down by ffmpeg, never up, capped.
import { describe, expect, it } from 'vitest';
import { scaleJpeg, jpegWidth } from '../../server/mcp/images';
import { ToolFailure } from '../../server/mcp/result';
import { jpegSize, testJpeg } from './media';

describe('scaleJpeg', () => {
  it('scales a large picture down to the width asked', async () => {
    const out = await scaleJpeg(testJpeg(1920, 1080), 640);
    expect(out.width).toBe(640);
    expect(jpegSize(out.data)).toEqual({ width: 640, height: 360 });
    expect(out.data.length).toBeLessThan(400 * 1024);
  });

  it('never scales up', async () => {
    const out = await scaleJpeg(testJpeg(320, 180), 1024);
    expect(out.width).toBe(320);
  });

  it('refuses what is not a picture', async () => {
    await expect(scaleJpeg(Buffer.from('not a jpeg'), 640)).rejects.toBeInstanceOf(ToolFailure);
  });

  it('reads a JPEG width', () => {
    expect(jpegWidth(testJpeg(400, 300))).toBe(400);
    expect(jpegWidth(Buffer.from('x'))).toBeNull();
  });
});
