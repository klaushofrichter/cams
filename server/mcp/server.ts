// One McpServer per request (stateless Streamable HTTP, spec
// 2026-10-27-mcp-server-design §7), its tools bound to the token's context.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { logger } from '../logger';
import type { Principal } from '../middleware/requireAuth';
import { appVersion } from '../version';
import { callApi, type InternalBase } from './internal';
import { fail, failureOf, ToolFailure } from './result';
import type { StoredToken } from './tokens';
import { registerArchiveTools } from './tools/archive';
import { registerCameraTools } from './tools/cameras';
import { registerEventTools } from './tools/events';
import { registerSnapshotTool } from './tools/snapshot';

export interface Audit { tool?: string; camera?: string; outcome?: string; imageBytes?: number }
export interface ApiInit { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }
export interface ToolCtx {
  principal: Principal;
  token: StoredToken;
  origin: string;
  audit: Audit;
  // An /api call as the token (status as it comes).
  api: (path: string, init?: ApiInit) => Promise<Response>;
  // An /api call whose failure ends the tool with the matching error.
  json: <T>(path: string, init?: ApiInit) => Promise<T>;
  bytes: (path: string, init?: ApiInit) => Promise<{ data: Buffer; headers: Headers }>;
}

export function makeCtx(principal: Principal, token: StoredToken, base: InternalBase, origin: string): ToolCtx {
  const api = async (path: string, init?: ApiInit) => {
    try {
      return await callApi(base, token.id, path, init);
    } catch {
      throw new ToolFailure('proxy_unavailable', 'cams could not complete the request.');
    }
  };
  return {
    principal, token, origin, audit: {}, api,
    json: async <T>(path: string, init?: ApiInit) => {
      const r = await api(path, init);
      if (!r.ok) throw await failureOf(r);
      return (await r.json()) as T;
    },
    bytes: async (path: string, init?: ApiInit) => {
      const r = await api(path, init);
      if (!r.ok) throw await failureOf(r);
      return { data: Buffer.from(await r.arrayBuffer()), headers: r.headers };
    },
  };
}

export const CAMERA = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'a camera id from list_cameras');
export const ERROR_SHAPE = { error: z.string(), message: z.string(), retryable: z.boolean() };

export interface ToolDef<I extends z.ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  input: I;
  output: z.ZodTypeAny;
  readOnly?: boolean;
  run: (args: z.infer<I>, ctx: ToolCtx) => Promise<CallToolResult>;
}

// Registers a tool with the common wrapper: the audit fields, and a
// ToolFailure (or anything unexpected) as a tool error.
export function addTool<I extends z.ZodTypeAny>(server: McpServer, ctx: ToolCtx, def: ToolDef<I>): void {
  server.registerTool(
    def.name,
    { title: def.title, description: def.description, inputSchema: def.input as never, outputSchema: def.output as never, annotations: { readOnlyHint: def.readOnly !== false, openWorldHint: false } },
    (async (args: unknown) => {
      ctx.audit.tool = def.name;
      const cam = (args as { camera?: unknown } | null)?.camera;
      if (typeof cam === 'string') ctx.audit.camera = cam;
      try {
        const r = await def.run(args as z.infer<I>, ctx);
        ctx.audit.outcome = r.isError ? String((r.structuredContent as { error?: unknown } | undefined)?.error ?? 'error') : 'ok';
        ctx.audit.imageBytes = r.content.reduce((n, c) => n + (c.type === 'image' ? Math.floor((c.data.length * 3) / 4) : 0), 0);
        return r;
      } catch (err) {
        if (err instanceof ToolFailure) {
          ctx.audit.outcome = err.code;
          return fail(err.code, err.message);
        }
        logger.warn({ tool: def.name, message: (err as Error).message }, 'mcp_tool_failed');
        ctx.audit.outcome = 'error';
        return fail('proxy_unavailable', 'cams could not complete the request.');
      }
    }) as never,
  );
}

export function buildServer(ctx: ToolCtx): McpServer {
  const server = new McpServer({ name: 'cams', version: appVersion() }, { capabilities: { tools: {} }, instructions: 'Read-only access to the cameras of one cams account: events with AI labels, stills, recordings, the archive, and short clips. Times are ISO 8601 with an offset, or unix ms. Videos come back as links valid for 15 minutes.' });
  registerCameraTools(server, ctx);
  registerSnapshotTool(server, ctx);
  registerEventTools(server, ctx);
  registerArchiveTools(server, ctx);
  return server;
}
