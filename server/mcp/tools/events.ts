// list_events, get_event and search_recordings (spec 2026-10-27-mcp-server-design
// §3): the Video page's day lists (/api/cameras/:id/events, with the AI labels
// and Vision's word), over a range of days; get_event adds its pictures.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MAX_IMAGES, MAX_RESULT_IMAGE_BYTES, scaleJpeg } from '../images';
import { linkFor } from '../links';
import { ok, parseTime, ToolFailure, type Image } from '../result';
import { addTool, CAMERA, type ToolCtx } from '../server';
import { WIDTH } from './snapshot';
import { eventsOfDay, kindsOf, toEvent, utcDate, type Card } from './common';

const DAY = 86_400_000;
export const TIME = z.union([z.string().max(40), z.number().int().nonnegative()]);
const KIND = z.enum(['person', 'vehicle', 'pet', 'motion', 'timer']);
const CLIP_ID = /^\d{8}-\d{6}-\d{6}$/;

const EVENT = z.object({
  id: z.string(), startMs: z.number(), endMs: z.number(), start: z.string(), end: z.string(), durationS: z.number(), kinds: z.array(z.string()),
  counts: z.record(z.string(), z.number()),
  vision: z.object({ best: z.record(z.string(), z.number()), notConfirmed: z.array(z.string()) }).nullable(),
});
const LINK = z.object({ url: z.string(), expiresAtMs: z.number() });

// [from, to] in ms; refuses a bad time, a backwards range, or one over maxDays.
export function rangeOf(from: unknown, to: unknown, maxDays: number): [number, number] {
  const f = parseTime(from), t = parseTime(to);
  if (f === null || t === null) throw new ToolFailure('invalid', 'from and to are ISO 8601 times with an offset, or unix ms.');
  if (t < f) throw new ToolFailure('invalid', 'to is before from.');
  if (t - f > maxDays * DAY) throw new ToolFailure('range_too_large', `At most ${maxDays} days per request.`);
  return [f, t];
}

// The camera-local dates a UTC range can touch: a day either side.
export function datesCovering(from: number, to: number): string[] {
  const out: string[] = [];
  for (let d = Date.parse(utcDate(from - DAY)); d <= to + DAY; d += DAY) out.push(utcDate(d));
  return out;
}

const inRange = (c: Card, [f, t]: [number, number]) => {
  const s = Date.parse(c.start);
  return s >= f && s <= t;
};
const hasKind = (c: Card, kinds?: string[]) => !kinds?.length || c.triggers.some((k) => kinds.includes(k));
const confirmed = (c: Card) => Object.keys(c.analysis?.best ?? {}).filter((k) => c.triggers.includes(k));

async function cardsIn(ctx: ToolCtx, camera: string, range: [number, number], dates: string[]): Promise<Card[]> {
  const out: Card[] = [];
  for (const d of dates) out.push(...(await eventsOfDay(ctx, camera, d)).filter((c) => inRange(c, range)));
  // A card listed on two days (a clip across midnight) once.
  return [...new Map(out.map((c) => [c.id, c])).values()].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
}

export function registerEventTools(server: McpServer, ctx: ToolCtx): void {
  addTool(server, ctx, {
    name: 'list_events',
    title: 'List events',
    description: "A camera's recorded events between two times (at most 7 days), newest first: kinds (person, vehicle, pet, motion, timer), counts per AI kind, and Vision's confirmation where the camera has a cam-proxy.",
    input: z.object({ camera: CAMERA, from: TIME, to: TIME, kinds: z.array(KIND).max(5).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
    output: z.object({ camera: z.string(), events: z.array(EVENT), truncated: z.boolean() }),
    run: async ({ camera, from, to, kinds, limit }, c) => {
      const range = rangeOf(from, to, 7);
      const cards = (await cardsIn(c, camera, range, datesCovering(...range))).filter((x) => hasKind(x, kinds));
      const max = limit ?? 100;
      return ok({ camera, events: cards.slice(0, max).map(toEvent), truncated: cards.length > max });
    },
  });

  addTool(server, ctx, {
    name: 'get_event',
    title: 'One event',
    description: "One event by its id (from list_events): its details, the objects Vision found on its analysed stills, a link to its video (15 minutes), and up to `images` pictures (default 1: the event's thumbnail, then analysed stills).",
    input: z.object({ camera: CAMERA, eventId: z.string().regex(CLIP_ID), images: z.number().int().min(0).max(MAX_IMAGES).optional(), maxWidth: WIDTH.optional() }).strict(),
    output: z.object({ event: EVENT, stills: z.array(z.object({ ts: z.number(), kind: z.string(), objects: z.array(z.object({ category: z.string(), subtype: z.string(), score: z.number() })) })), video: LINK }),
    run: async ({ camera, eventId, images, maxWidth }, c) => {
      const date = `${eventId.slice(0, 4)}-${eventId.slice(4, 6)}-${eventId.slice(6, 8)}`;
      const card = (await eventsOfDay(c, camera, date)).find((x) => x.id === eventId);
      if (!card) throw new ToolFailure('not_found', 'There is no event with that id on this camera.');
      const stills = card.analysis?.stills ?? [];
      const want = images ?? 1;
      const width = maxWidth ?? 768;
      const sources = [
        `/api/cameras/${encodeURIComponent(camera)}/clips/${eventId}/thumb.jpg${card.thumb && /^[cd]\d{1,15}(-r\d{1,15})?$/.test(card.thumb) ? `?v=${card.thumb}` : ''}`,
        ...stills.filter((s) => Number.isSafeInteger(s.stillTs)).map((s) => `/api/cameras/${encodeURIComponent(camera)}/stills/${s.stillTs}.jpg`),
      ].slice(0, want);
      const pics: Image[] = [];
      let total = 0;
      for (const path of sources) {
        try {
          const img = await scaleJpeg((await c.bytes(path)).data, width);
          if (total + img.data.length > MAX_RESULT_IMAGE_BYTES) break;
          total += img.data.length;
          pics.push({ data: img.data, mime: 'image/jpeg' });
        } catch {
          /* a picture that can't be had is left out */
        }
      }
      return ok({
        event: toEvent(card),
        stills: stills.map((s) => ({ ts: s.stillTs, kind: s.kind, objects: s.summary.map((o) => ({ category: o.category, subtype: o.subtype, score: o.score })) })),
        video: linkFor(c, { cam: camera, kind: 'clip', ref: eventId }),
      }, pics);
    },
  });

  addTool(server, ctx, {
    name: 'search_recordings',
    title: 'Search recordings',
    description: 'Events across cameras between two times (at most 31 days), newest first, filtered by kinds, Vision confirmation and minimum length. Days without recordings are skipped.',
    input: z.object({
      from: TIME, to: TIME, cameras: z.array(CAMERA).max(32).optional(), kinds: z.array(KIND).max(5).optional(), visionConfirmed: z.boolean().optional(),
      minDurationS: z.number().int().min(0).max(86_400).optional(), limit: z.number().int().min(1).max(200).optional(),
    }).strict(),
    output: z.object({ hits: z.array(z.object({ camera: z.string(), id: z.string(), startMs: z.number(), durationS: z.number(), kinds: z.array(z.string()), visionConfirmed: z.array(z.string()) })), daysSearched: z.number(), truncated: z.boolean() }),
    run: async ({ from, to, cameras, kinds, visionConfirmed, minDurationS, limit }, c) => {
      const range = rangeOf(from, to, 31);
      const known = (await c.json<{ id: string }[]>('/api/cameras')).map((x) => x.id);
      const pick = cameras ?? known;
      if (pick.some((id) => !known.includes(id))) throw new ToolFailure('unknown_camera');
      const covering = datesCovering(...range);
      const months = [...new Set(covering.map((d) => d.slice(0, 7)))];
      let daysSearched = 0;
      const hits: { camera: string; id: string; startMs: number; durationS: number; kinds: string[]; visionConfirmed: string[] }[] = [];
      for (const camera of pick) {
        const days = new Set<string>();
        for (const m of months) {
          const r = await c.json<{ days?: unknown }>(`/api/cameras/${encodeURIComponent(camera)}/days?month=${m}`);
          for (const d of Array.isArray(r.days) ? r.days : []) if (typeof d === 'string' && covering.includes(d)) days.add(d);
        }
        const list = [...days].sort().reverse();
        daysSearched += list.length;
        for (const card of await cardsIn(c, camera, range, list)) {
          if (!hasKind(card, kinds) || (minDurationS !== undefined && card.durationSec < minDurationS)) continue;
          const conf = confirmed(card);
          if (visionConfirmed === true && !conf.length) continue;
          if (visionConfirmed === false && conf.length) continue;
          hits.push({ camera, id: card.id, startMs: Date.parse(card.start), durationS: card.durationSec, kinds: kindsOf(card), visionConfirmed: conf });
        }
      }
      hits.sort((a, b) => b.startMs - a.startMs);
      const max = limit ?? 50;
      return ok({ hits: hits.slice(0, max), daysSearched, truncated: hits.length > max });
    },
  });
}
