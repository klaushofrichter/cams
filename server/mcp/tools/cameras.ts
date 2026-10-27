// list_cameras (spec 2026-10-27-mcp-server-design §3): the account's cameras,
// whether each answers, and its newest event of the last two days.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../result';
import { addTool, type ToolCtx } from '../server';
import { eventsOfDay, kindsOf, utcDate } from './common';

interface CameraItem { id: string; name: string; proxy: boolean }
interface Status { online?: boolean; model?: string; simulator?: string | null }

const OUTPUT = z.object({
  cameras: z.array(z.object({
    id: z.string(), name: z.string(), online: z.boolean().nullable(), model: z.string().nullable(), simulated: z.boolean(), hasProxy: z.boolean(),
    lastEvent: z.object({ id: z.string(), startMs: z.number(), kinds: z.array(z.string()) }).nullable(),
  })),
});

async function describe(c: CameraItem, ctx: ToolCtx) {
  const signal = AbortSignal.timeout(15_000);
  const [status, last] = await Promise.all([
    ctx.json<Status>(`/api/cameras/${encodeURIComponent(c.id)}/status`, { signal }).catch(() => null),
    (async () => {
      const now = Date.now();
      const days = await Promise.all([utcDate(now), utcDate(now - 86_400_000)].map((d) => eventsOfDay(ctx, c.id, d, signal).catch(() => [])));
      const all = days.flat().sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
      return all[0] ?? null;
    })(),
  ]);
  return {
    id: c.id,
    name: c.name,
    online: status ? status.online === true : null,
    model: status && typeof status.model === 'string' ? status.model : null,
    simulated: !!status && typeof status.simulator === 'string',
    hasProxy: c.proxy === true,
    lastEvent: last ? { id: last.id, startMs: Date.parse(last.start), kinds: kindsOf(last) } : null,
  };
}

export function registerCameraTools(server: McpServer, ctx: ToolCtx): void {
  addTool(server, ctx, {
    name: 'list_cameras',
    title: 'List cameras',
    description: "The account's cameras: id, name, whether each is online, model, whether it is simulated and has a cam-proxy, and its newest event of the last two days.",
    input: z.object({}).strict(),
    output: OUTPUT,
    run: async (_args, c) => {
      const list = await c.json<CameraItem[]>('/api/cameras');
      return ok({ cameras: await Promise.all(list.map((x) => describe(x, c))) });
    },
  });
}
