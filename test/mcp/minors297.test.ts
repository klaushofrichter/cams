// #297 leftovers: ctx.bytes reads at most 32 MB, and the MCP's ffmpeg runs
// share one gate with the thumbnails' (at most 2 ffmpeg processes in all).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const answer = vi.hoisted(() => ({ make: (): Response => new Response('') }));
vi.mock('../../server/mcp/internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/mcp/internal')>()),
  callApi: async () => answer.make(),
}));

import { makeCtx } from '../../server/mcp/server';
import { ffmpegGate } from '../../server/ffmpegGate';
import { scaleJpeg } from '../../server/mcp/images';
import { makeThumbnail } from '../../server/recordings/thumbnail';
import { ToolFailure } from '../../server/mcp/result';

const MB = 1024 * 1024;
const ctx = () => makeCtx({ email: 'a@example.org', via: 'mcp', account: { id: 'acc_X', name: 'x', displayName: 'X' }, role: 'admin' }, { id: 'mtk_X' } as never, {} as never, 'http://127.0.0.1');

describe('ctx.bytes', () => {
  it('refuses a body over 32 MB by its Content-Length, without reading it', async () => {
    answer.make = () => new Response(new ReadableStream({ pull: () => undefined }), { headers: { 'Content-Length': String(33 * MB) } });
    await expect(ctx().bytes('/api/x')).rejects.toMatchObject({ code: 'image_too_large' });
  });
  it('stops reading a body without Content-Length once it passes 32 MB', async () => {
    let sent = 0;
    answer.make = () => new Response(new ReadableStream({ pull: (c) => { sent += MB; c.enqueue(new Uint8Array(MB)); } }));
    await expect(ctx().bytes('/api/x')).rejects.toBeInstanceOf(ToolFailure);
    expect(sent).toBeLessThanOrEqual(34 * MB);
  });
  it('reads a normal body', async () => {
    answer.make = () => new Response(Buffer.from([1, 2, 3]));
    expect([...(await ctx().bytes('/api/x')).data]).toEqual([1, 2, 3]);
  });
});

describe('one ffmpeg gate', () => {
  const saved = process.env.FFMPEG_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = saved;
  });
  // A stand-in ffmpeg that only leaves a mark that it ran.
  function fakeFfmpeg(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ffgate-'));
    const bin = join(dir, 'ffmpeg');
    writeFileSync(bin, `#!/bin/sh\ntouch "${dir}/ran-$$"\nexit 1\n`);
    chmodSync(bin, 0o755);
    process.env.FFMPEG_PATH = bin;
    return dir;
  }
  it('an MCP picture and a thumbnail both wait while the gate is full', async () => {
    const dir = fakeFfmpeg();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // Both slots taken (two other ffmpeg runs).
    const busy = [ffmpegGate.run(() => held), ffmpegGate.run(() => held)];
    const pic = scaleJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 100).catch(() => undefined);
    const thumb = makeThumbnail(join(dir, 'in.mp4'), join(dir, 'out.jpg')).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    const ran = () => require('fs').readdirSync(dir).filter((f: string) => f.startsWith('ran-')).length;
    expect(ran()).toBe(0);
    release();
    await Promise.all([...busy, pic, thumb]);
    expect(ran()).toBeGreaterThanOrEqual(2);
    expect(existsSync(dir)).toBe(true);
  });
});
