// Shared by the event tools: one day's cards from /api, and their shape for the model.
import type { ToolCtx } from '../server';

export interface Card {
  id: string;
  start: string;
  end: string;
  durationSec: number;
  triggers: string[];
  counts?: Partial<Record<'person' | 'vehicle' | 'pet', number>>;
  thumb?: string;
  analysis?: {
    best: Partial<Record<string, { score: number; subtype: string }>>;
    notConfirmed: string[];
    stills: { eventId: number; kind: string; stillTs: number; summary: { category: string; subtype: string; score: number }[]; checkId?: number }[];
  };
}

export const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export async function eventsOfDay(ctx: ToolCtx, camera: string, date: string, signal?: AbortSignal): Promise<Card[]> {
  const r = await ctx.json<{ events?: Card[] }>(`/api/cameras/${encodeURIComponent(camera)}/events?date=${date}`, { signal });
  return Array.isArray(r.events) ? r.events : [];
}

export const kindsOf = (c: Card): string[] => [...new Set(c.triggers.map((t) => (t === 'timer' ? 'timer' : t)))];

export interface Event {
  id: string; startMs: number; endMs: number; start: string; end: string; durationS: number; kinds: string[];
  counts: Partial<Record<'person' | 'vehicle' | 'pet', number>>;
  vision: { best: Record<string, number>; notConfirmed: string[] } | null;
}

export function toEvent(c: Card): Event {
  const best: Record<string, number> = {};
  for (const [k, v] of Object.entries(c.analysis?.best ?? {})) if (v) best[k] = v.score;
  return {
    id: c.id, startMs: Date.parse(c.start), endMs: Date.parse(c.end), start: c.start, end: c.end, durationS: c.durationSec, kinds: kindsOf(c),
    counts: c.counts ?? {},
    vision: c.analysis ? { best, notConfirmed: [...c.analysis.notConfirmed] } : null,
  };
}
