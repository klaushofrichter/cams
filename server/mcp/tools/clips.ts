// generate_clip and get_clip_job (spec 2026-10-27-mcp-server-design §3):
// the Save dialog's composed clip ("around a second", or an event with
// rolls) through /api/cameras/:id/compositions. Never archived.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatSeconds, generateMaxS } from '../../clipLimits';
import { activeJob, jobOf, refresh, resultExpiry, settle, track, type McpJob } from '../jobs';
import { limits } from '../limits';
import { linkFor } from '../links';
import { failureOf, ok, parseTime, ToolFailure } from '../result';
import { addTool, CAMERA, type ToolCtx } from '../server';
import { TIME } from './events';

const SIZE = z.enum(['sd', '360p', '720p', '1080p']);
const JOB = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const OUTPUT = z.object({
  job: z.string(), state: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']), progress: z.number(), durationS: z.number().nullable(), error: z.string().nullable(),
  video: z.object({ url: z.string(), expiresAtMs: z.number() }).nullable(),
});

function view(ctx: ToolCtx, j: McpJob) {
  const exp = resultExpiry(j);
  return {
    job: j.job, state: j.state, progress: j.progress, durationS: j.durationS, error: j.error,
    video: exp !== null && exp > Date.now() ? linkFor(ctx, { cam: j.camera, kind: 'composition', ref: j.job, exp }) : null,
  };
}

// The compositions body for a time range: around its first second, the rest
// as post-roll, never past the last second gone by.
function aroundBody(start: number, end: number, size: string, badge: boolean) {
  const at = Math.floor(start / 1000) * 1000;
  const last = Math.min(end, Math.floor(Date.now() / 1000) * 1000 - 1000);
  if (last < at) throw new ToolFailure('invalid', 'end must be after start, and start in the past.');
  const postS = Math.max(0, Math.round((last - at) / 1000) - 1);
  const maxS = generateMaxS(size);
  if (postS + 1 > maxS) throw new ToolFailure('too_long', `At most ${formatSeconds(maxS)} at ${size}.`);
  return { at, preS: 0, postS, size, badge };
}

export function registerClipTools(server: McpServer, ctx: ToolCtx): void {
  addTool(server, ctx, {
    name: 'generate_clip',
    title: 'Make a clip',
    description: "Makes a short video on a camera with a cam-proxy: either a time range (start, end) or an event (eventId) with optional pre- and post-roll in seconds. At most 5 minutes (2 at 1080p). Filled from recordings, else the proxy's stills (1 per second). Waits up to 25 s; if it is still running, ask get_clip_job. Returns a link valid for 15 minutes. One clip per account at a time.",
    readOnly: false,
    input: z.object({
      camera: CAMERA, start: TIME.optional(), end: TIME.optional(), eventId: z.string().regex(/^\d{8}-\d{6}-\d{6}$/).optional(),
      preS: z.number().int().min(-3600).max(3600).optional(), postS: z.number().int().min(-3600).max(3600).optional(), size: SIZE.optional(), badge: z.boolean().optional(),
    }).strict(),
    output: OUTPUT,
    run: async ({ camera, start, end, eventId, preS, postS, size, badge }, c) => {
      const sz = size ?? 'sd';
      let body: Record<string, unknown>;
      if (eventId !== undefined) {
        if (start !== undefined || end !== undefined) throw new ToolFailure('invalid', 'Give either eventId or start and end.');
        body = { eventId, preS: preS ?? 0, postS: postS ?? 0, size: sz, badge: badge ?? true };
      } else {
        const s = parseTime(start), e = parseTime(end);
        if (s === null || e === null) throw new ToolFailure('invalid', 'start and end are ISO 8601 times with an offset, or unix ms (or give eventId).');
        if (e <= s) throw new ToolFailure('invalid', 'end must be after start.');
        if (preS !== undefined || postS !== undefined) throw new ToolFailure('invalid', 'preS and postS go with eventId.');
        if (e - s > generateMaxS(sz) * 1000) throw new ToolFailure('too_long', `At most ${formatSeconds(generateMaxS(sz))} at ${sz}.`);
        body = aroundBody(s, e, sz, badge ?? true);
      }
      if (activeJob(c.token.accountId)) throw new ToolFailure('busy');
      if (limits.clipsHour.peek(c.token.accountId)) throw new ToolFailure('rate_limited', 'At most 10 clips an hour for this account.');
      const r = await c.api(`/api/cameras/${encodeURIComponent(camera)}/compositions`, { method: 'POST', body });
      if (r.status === 409) {
        await r.body?.cancel();
        throw new ToolFailure('nothing_kept', 'Nothing is kept for that time: no recording and no stills.');
      }
      if (r.status === 400) {
        const b = (await r.json().catch(() => null)) as { detail?: unknown } | null;
        const detail = typeof b?.detail === 'string' ? b.detail.slice(0, 160) : undefined;
        throw new ToolFailure(detail && /at most/i.test(detail) ? 'too_long' : 'invalid', detail);
      }
      if (r.status !== 201) throw await failureOf(r);
      const created = (await r.json()) as { id?: unknown; state?: unknown; progress?: unknown; durationS?: unknown };
      if (typeof created.id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(created.id)) throw new ToolFailure('proxy_unavailable');
      limits.clipsHour.take(c.token.accountId);
      const job = track({
        job: created.id, accountId: c.token.accountId, tokenId: c.token.id, camera, base: c.base,
        state: created.state === 'done' ? 'done' : created.state === 'queued' ? 'queued' : 'running',
        progress: typeof created.progress === 'number' ? created.progress : 0,
        durationS: Number.isFinite(created.durationS) ? (created.durationS as number) : null,
      });
      return ok(view(c, await settle(job)));
    },
  });

  addTool(server, ctx, {
    name: 'get_clip_job',
    title: 'Clip progress',
    description: 'The state of a clip started with generate_clip by this token, and its link once done (valid until the clip is dropped, 15 minutes after it was made).',
    input: z.object({ job: JOB }).strict(),
    output: OUTPUT,
    run: async ({ job }, c) => {
      const j = jobOf(c.token.id, job);
      if (!j) throw new ToolFailure('not_found', 'There is no clip job with that id for this token.');
      return ok(view(c, await refresh(j)));
    },
  });
}
