// analytics_usage (spec 2026-10-27-mcp-server-design §3): the second AI
// check's (Google Vision's) budget on each camera's cam-proxy.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, ToolFailure } from '../result';
import { addTool, CAMERA, type ToolCtx } from '../server';

interface Usage { enabled: boolean; paused: { reason: string; until: number | null } | null; month: { calls: number; limit: number }; today: { calls: number; cap: number }; checks: { today: number; cap: number } }

const USAGE = z.union([
  z.object({
    camera: z.string(), enabled: z.boolean(), paused: z.object({ reason: z.string(), untilMs: z.number().nullable() }).nullable(),
    month: z.object({ calls: z.number(), limit: z.number() }), today: z.object({ calls: z.number(), cap: z.number() }), checks: z.object({ today: z.number(), cap: z.number() }),
  }),
  z.object({ camera: z.string(), error: z.string() }),
]);

export function registerAnalyticsTool(server: McpServer, ctx: ToolCtx): void {
  addTool(server, ctx, {
    name: 'analytics_usage',
    title: 'AI check budget',
    description: "The second AI check's (Google Vision on the cam-proxy) budget: whether it is on or paused, calls this month against the limit, today's calls against the cap, and today's still checks. Every camera with a cam-proxy, or one.",
    input: z.object({ camera: CAMERA.optional() }).strict(),
    output: z.object({ usage: z.array(USAGE) }),
    run: async ({ camera }, c) => {
      const cams = await c.json<{ id: string; proxy: boolean }[]>('/api/cameras');
      if (camera !== undefined && !cams.some((x) => x.id === camera)) throw new ToolFailure('unknown_camera');
      const pick = camera !== undefined ? [camera] : cams.filter((x) => x.proxy).map((x) => x.id);
      const usage = await Promise.all(pick.map(async (id) => {
        try {
          const u = await c.json<Usage>(`/api/cameras/${encodeURIComponent(id)}/analytics`);
          return { camera: id, enabled: u.enabled, paused: u.paused ? { reason: u.paused.reason, untilMs: u.paused.until } : null, month: u.month, today: u.today, checks: u.checks };
        } catch (e) {
          if (e instanceof ToolFailure) return { camera: id, error: e.code };
          throw e;
        }
      }));
      return ok({ usage });
    },
  });
}
