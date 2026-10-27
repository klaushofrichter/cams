// list_archive and get_archive_clip (spec 2026-10-27-mcp-server-design §3):
// the Archive page's list and items (/api/archive), refs as "<via>:<id>".
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { scaleJpeg } from '../images';
import { linkFor } from '../links';
import { ok, parseTime, ToolFailure, type Image } from '../result';
import { addTool, CAMERA, type ToolCtx } from '../server';
import { TIME } from './events';

interface Item {
  via: string; id: number; camera: string | null; cameraName: string; name: string; labels: string[]; expiresAt: number | null;
  recordedFrom: number; recordedTo: number; durationS: number; quality: string; bytes: number; eventKinds: string[];
}
const REF = /^([a-z0-9][a-z0-9-]{0,31}):(\d{1,12})$/;
const LABEL = z.string().regex(/^[A-Za-z0-9]{1,32}$/);

const ITEM = z.object({
  ref: z.string(), name: z.string(), camera: z.string().nullable(), cameraName: z.string(), recordedFromMs: z.number(), recordedToMs: z.number(),
  durationS: z.number(), quality: z.string(), bytes: z.number(), labels: z.array(z.string()), expiresAtMs: z.number().nullable(),
});
const out = (i: Item) => ({
  ref: `${i.via}:${i.id}`, name: i.name, camera: i.camera, cameraName: i.cameraName, recordedFromMs: i.recordedFrom, recordedToMs: i.recordedTo,
  durationS: i.durationS, quality: i.quality, bytes: i.bytes, labels: [...i.labels], expiresAtMs: i.expiresAt,
});

export function registerArchiveTools(server: McpServer, ctx: ToolCtx): void {
  addTool(server, ctx, {
    name: 'list_archive',
    title: 'List archived clips',
    description: "Clips kept in the account's Archive (on each camera's cam-proxy, apart from normal retention): name, camera, recorded time, length, quality, size, labels, expiry. Filter by text, labels (all must match), camera and recorded time.",
    input: z.object({
      q: z.string().max(120).optional(), labels: z.array(LABEL).max(10).optional(), camera: CAMERA.optional(), from: TIME.optional(), to: TIME.optional(),
      sort: z.enum(['recorded', 'created']).optional(), order: z.enum(['asc', 'desc']).optional(), limit: z.number().int().min(1).max(100).optional(),
    }).strict(),
    output: z.object({ items: z.array(ITEM), unavailable: z.array(z.object({ via: z.string(), error: z.string() })), truncated: z.boolean() }),
    run: async ({ q, labels, camera, from, to, sort, order, limit }, c) => {
      const qs = new URLSearchParams({ sort: sort ?? 'recorded', order: order ?? 'desc' });
      if (q) qs.set('q', q);
      if (labels?.length) qs.set('labels', labels.join(','));
      if (camera) qs.set('cam', camera);
      for (const [k, v] of [['from', from], ['to', to]] as const) {
        if (v === undefined) continue;
        const t = parseTime(v);
        if (t === null) throw new ToolFailure('invalid', `${k} is an ISO 8601 time with an offset, or unix ms.`);
        qs.set(k, String(t));
      }
      const r = await c.json<{ items?: Item[]; proxies?: { via: string; ok: boolean; error?: string }[] }>(`/api/archive?${qs}`);
      const items = r.items ?? [];
      const max = limit ?? 50;
      return ok({
        items: items.slice(0, max).map(out),
        unavailable: (r.proxies ?? []).filter((p) => !p.ok).map((p) => ({ via: p.via, error: p.error ?? 'error' })),
        truncated: items.length > max,
      });
    },
  });

  addTool(server, ctx, {
    name: 'get_archive_clip',
    title: 'One archived clip',
    description: 'One archived clip by its ref (from list_archive): its details, a link to its video (15 minutes) and its thumbnail.',
    input: z.object({ ref: z.string().regex(REF, '<camera>:<id> from list_archive'), thumbnail: z.boolean().optional() }).strict(),
    output: z.object({ item: ITEM.extend({ eventKinds: z.array(z.string()) }), video: z.object({ url: z.string(), expiresAtMs: z.number() }) }),
    run: async ({ ref, thumbnail }, c: ToolCtx) => {
      const [, via, id] = REF.exec(ref)!;
      const item = await c.json<Item>(`/api/archive/${via}/items/${id}`).catch((e: unknown) => {
        throw e instanceof ToolFailure && (e.code === 'unknown_camera' || e.code === 'no_proxy') ? new ToolFailure('not_found') : e;
      });
      const pics: Image[] = [];
      if (thumbnail !== false) {
        try {
          const img = await scaleJpeg((await c.bytes(`/api/archive/${via}/items/${id}/thumbnail`)).data, 768);
          pics.push({ data: img.data, mime: 'image/jpeg' });
        } catch {
          /* no thumbnail */
        }
      }
      return ok({ item: { ...out(item), eventKinds: [...(item.eventKinds ?? [])] }, video: linkFor(c, { cam: via, kind: 'archive', ref: id }) }, pics);
    },
  });
}
