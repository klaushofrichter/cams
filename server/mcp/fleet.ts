// One account's fleet from cams-admin, for the admin tools (spec
// 2026-11-04-mcp-fleet-tools-design): over the signed client, never stored:
// one in-memory answer per account for a few seconds, dropped by a timer. The
// instance's 60 requests a minute at cams-admin also carry its config pull and
// report, so MCP sends at most 20 a minute. Every field is named by a schema:
// what cams-admin adds later doesn't reach an assistant by itself.
import { z } from 'zod';
import { AdminError, type AdminClient } from '../admin/client';
import { adminClient } from '../configSource';
import { logger } from '../logger';
import { ToolFailure } from './result';

const PLACE = z.object({ url: z.string(), scope: z.string(), note: z.string().nullable() }).nullable();
export const PROXY = z.object({
  name: z.string(), displayName: z.string(), state: z.string(), version: z.string().nullable(), ok: z.boolean().nullable(), problemCount: z.number().nullable(), reportedAt: z.number().nullable(),
  gui: PLACE,
  problems: z.array(z.object({ id: z.string().nullable(), label: z.string().nullable(), text: z.string().nullable(), camera: z.string().nullable() })),
  cameras: z.array(z.object({ id: z.string(), name: z.string(), online: z.boolean().nullable() })),
});
const HELD = z.object({ camera: z.string(), fields: z.array(z.string()) });
export const VIEWER = z.object({
  name: z.string(), displayName: z.string(), thisViewer: z.boolean(), address: PLACE, held: z.array(HELD), keptOld: z.array(HELD),
  heldProxies: z.array(z.object({ proxy: z.string(), fields: z.array(z.string()) })), heldTotal: z.number(),
});
export const MOVE = z.object({
  id: z.string(), camera: z.string().nullable(), cameraName: z.string().nullable(), source: z.string().nullable(), target: z.string().nullable(), phase: z.string(), reason: z.string().nullable(),
  bytesTotal: z.number().nullable(), bytesDone: z.number().nullable(), rateBps: z.number().nullable(), etaS: z.number().nullable(),
  chunks: z.object({ pending: z.number(), copied: z.number(), verified: z.number(), skipped: z.number(), failed: z.number(), abandoned: z.number() }),
  createdAt: z.number(), updatedAt: z.number(), endedAt: z.number().nullable(),
});
// PoE switches (spec 2026-11-07-poe-switches-design): the address is shown like a proxy's gui, with its note.
export const SWITCH = z.object({
  name: z.string(), model: z.string(), address: PLACE, proxy: z.string().nullable(), state: z.string(), readAt: z.number().nullable(), ports: z.number(),
});
const CYCLE = z.object({ state: z.string(), requestedAt: z.number().nullable(), finishedAt: z.number().nullable(), code: z.string().nullable(), reason: z.string().nullable() });
export const POWER = z.object({
  camera: z.string(), cameraName: z.string().nullable(), kind: z.string(), switch: z.string().nullable(), port: z.number().nullable(), watts: z.number().nullable(),
  verifiedAt: z.number().nullable(), notSeen: z.boolean(), lastCycle: CYCLE.nullable(),
});
// switches and cameraPower are new in cams-admin: an older one leaves them out (nothing to list).
const ANSWER = z.object({
  accountId: z.string(), proxies: z.array(PROXY), notRouted: z.number(), viewers: z.array(VIEWER), moves: z.array(MOVE),
  switches: z.array(SWITCH).default([]), cameraPower: z.array(POWER).default([]),
});
export type Fleet = z.infer<typeof ANSWER>;

export const readFleet = (body: unknown): Fleet => ANSWER.parse(body);

const KEEP_MS = 5_000, WINDOW_MS = 60_000, PER_WINDOW = 20;
let keepMs = KEEP_MS;
const kept = new Map<string, Promise<Fleet>>();
let sentAt: number[] = [];

// Tests: forget everything; `keep` a shorter time (no argument: the default).
export function resetFleetAnswers(keep = KEEP_MS): void {
  keepMs = keep;
  kept.clear();
  sentAt = [];
}

async function ask(client: AdminClient, accountId: string): Promise<Fleet> {
  try {
    const fleet = readFleet(await client.getFleet(accountId));
    if (fleet.accountId !== accountId) throw new ToolFailure('admin_unavailable');
    return fleet;
  } catch (err) {
    if (err instanceof ToolFailure) throw err;
    if (err instanceof AdminError && err.code === 'refused') {
      if (err.status === 404) throw new ToolFailure('not_available', "This viewer's cams-admin doesn't offer this yet: it needs an update.");
      if (err.status === 403) throw new ToolFailure('forbidden', "cams-admin refused: this viewer doesn't serve this account, or is blocked.");
      if (err.status === 429) throw new ToolFailure('rate_limited');
    }
    if (!(err instanceof AdminError)) logger.warn({ kind: 'mcp_fleet' }, 'fleet_answer_unreadable');
    throw new ToolFailure('admin_unavailable');
  }
}

export function fleetOf(accountId: string): Promise<Fleet> {
  const have = kept.get(accountId);
  if (have) return have;
  const client = adminClient();
  if (!client) return Promise.reject(new ToolFailure('not_available', "This viewer isn't connected to cams-admin, which keeps the fleet."));
  const now = Date.now();
  sentAt = sentAt.filter((t) => now - t < WINDOW_MS);
  if (sentAt.length >= PER_WINDOW) return Promise.reject(new ToolFailure('rate_limited'));
  sentAt.push(now);
  const answer = ask(client, accountId);
  kept.set(accountId, answer);
  const forget = () => {
    if (kept.get(accountId) === answer) kept.delete(accountId);
  };
  answer.then(() => void setTimeout(forget, keepMs).unref(), forget);
  return answer;
}
