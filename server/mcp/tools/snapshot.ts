// get_snapshot (spec 2026-10-27-mcp-server-design §3): the cam-proxy's newest
// still when it is at most 5 s old (no camera request), else the camera's
// own snapshot; scaled for the model.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { scaleJpeg } from '../images';
import { ok } from '../result';
import { addTool, CAMERA, type ToolCtx } from '../server';

const FRESH_MS = 5000;
export const WIDTH = z.number().int().min(320).max(1568);

async function proxyStill(ctx: ToolCtx, camera: string): Promise<{ data: Buffer; ts: number } | null> {
  const r = await ctx.api(`/api/cameras/${encodeURIComponent(camera)}/still/latest.jpg`);
  if (!r.ok) {
    await r.body?.cancel();
    return null;
  }
  const ts = Number(r.headers.get('x-still-time'));
  const data = Buffer.from(await r.arrayBuffer());
  return Number.isSafeInteger(ts) && Date.now() - ts <= FRESH_MS ? { data, ts } : null;
}

export function registerSnapshotTool(server: McpServer, ctx: ToolCtx): void {
  addTool(server, ctx, {
    name: 'get_snapshot',
    title: 'Current picture',
    description: "A camera's current picture as an image, scaled to maxWidth (default 1024). It is the cam-proxy's newest still when that is at most 5 s old, else the camera's own snapshot.",
    input: z.object({ camera: CAMERA, maxWidth: WIDTH.optional() }).strict(),
    output: z.object({ camera: z.string(), takenAtMs: z.number(), source: z.enum(['proxy-still', 'camera']), width: z.number(), bytes: z.number() }),
    run: async ({ camera, maxWidth }, c) => {
      const still = await proxyStill(c, camera);
      const src = still ?? { data: (await c.bytes(`/api/cameras/${encodeURIComponent(camera)}/snapshot.jpg`)).data, ts: Date.now() };
      const img = await scaleJpeg(src.data, maxWidth ?? 1024);
      return ok({ camera, takenAtMs: src.ts, source: still ? 'proxy-still' : 'camera', width: img.width, bytes: img.data.length }, [{ data: img.data, mime: 'image/jpeg' }]);
    },
  });
}
