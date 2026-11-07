// The fleet tools (spec 2026-11-04-mcp-fleet-tools-design): an account admin's
// read-only view of this account's proxies, viewers and moves, from cams-admin.
// No input: the account is the token's. Registered only for an admin; checked
// again here, so no path runs them for a viewer.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fleetOf, MOVE, POWER, problemText, PROXY, SWITCH, SWITCH_PROBLEM, VIEWER, type Fleet } from '../fleet';
import { ok, ToolFailure } from '../result';
import { addTool, type ToolCtx } from '../server';

const NO_INPUT = z.object({}).strict();

async function fleet(ctx: ToolCtx): Promise<Fleet> {
  if (ctx.principal.role !== 'admin') throw new ToolFailure('forbidden', "Only this account's admins can see its fleet.");
  return fleetOf(ctx.principal.account.id);
}

export function registerFleetTools(server: McpServer, ctx: ToolCtx): void {
  addTool(server, ctx, {
    name: 'list_proxies',
    title: 'List cam-proxies',
    description: "This account's cam-proxies (the gateways next to its cameras) that this viewer uses, from cams-admin: name, state (online, offline, ...), version, whether it reports problems and which (ids, labels, texts), the address of its own web page (gui: with a note when it is only reachable on a local network) and its cameras with online. notRouted counts the account's other proxies, which this viewer isn't routed to. Read-only; for this account's admins.",
    input: NO_INPUT,
    output: z.object({ proxies: z.array(PROXY), notRouted: z.number() }),
    run: async (_args, c) => {
      const f = await fleet(c);
      return ok({ proxies: f.proxies, notRouted: f.notRouted });
    },
  });
  addTool(server, ctx, {
    name: 'list_viewers',
    title: 'List cams viewers',
    description: "The cams viewers serving this account, from cams-admin: name, address (with a note when it is only reachable on a local network), whether it is the one answering (thisViewer), and its held changes for this account: held and keptOld name a camera and the fields whose new values wait for an admin's confirmation or were refused, heldProxies the same for a proxy. Field names only, never values. Read-only; for this account's admins.",
    input: NO_INPUT,
    output: z.object({ viewers: z.array(VIEWER) }),
    run: async (_args, c) => ok({ viewers: (await fleet(c)).viewers }),
  });
  addTool(server, ctx, {
    name: 'list_moves',
    title: 'List camera moves',
    description: "This account's camera moves between proxies, newest first, at most 50, from cams-admin: camera, source and target proxy, phase (requested, copying, done, cancelled, failed, ...), reason (a code, on a refused or failed move), progress (bytes, rate, seconds left, chunks) and times in unix ms. Read-only: moves can't be started or changed here. For this account's admins.",
    input: NO_INPUT,
    output: z.object({ moves: z.array(MOVE) }),
    run: async (_args, c) => ok({ moves: (await fleet(c)).moves }),
  });
  addTool(server, ctx, {
    name: 'switch_list',
    title: 'List PoE switches',
    description: "This account's PoE switches (they power and can power-cycle cameras), from cams-admin: name, model, address (with a note when it is only reachable on a local network), the proxy that operates it, state (pending, active; unknown for a value this viewer doesn't know), readAt (when its ports were last read, unix ms), its port count and problems (code, port, number of cameras, and text in words, e.g. another switch is chained on a port). Read-only; for this account's admins.",
    input: NO_INPUT,
    output: z.object({ switches: z.array(SWITCH.extend({ problems: z.array(SWITCH_PROBLEM.extend({ text: z.string() })) })) }),
    run: async (_args, c) => ok({ switches: (await fleet(c)).switches.map((sw) => ({ ...sw, problems: sw.problems.map((p) => ({ ...p, text: problemText(p) })) })) }),
  });
  addTool(server, ctx, {
    name: 'camera_power',
    title: 'Camera power',
    description: "How one camera is powered, from cams-admin: kind (poe, data-only, adapter, unknown), the switch's name and port, watts, verifiedAt (unix ms, when the port was last confirmed), notSeen (the port did not show the camera at the last check) and a summary of its last power-cycle (state, requestedAt, finishedAt, code, reason). Input: camera, an id or name from list_cameras. Read-only; power-cycles can't be started here. For this account's admins.",
    input: z.object({ camera: z.string().min(1).max(128) }).strict(),
    output: z.object({ power: POWER }),
    run: async (args, c) => {
      const f = await fleet(c);
      const want = args.camera.trim().toLowerCase();
      const hit = f.cameraPower.find((p) => p.camera.toLowerCase() === want) ?? f.cameraPower.find((p) => (p.cameraName ?? '').toLowerCase() === want);
      if (!hit) throw new ToolFailure('unknown_camera');
      return ok({ power: hit });
    },
  });
}
