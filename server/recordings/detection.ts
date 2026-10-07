import { getProxyClient, proxyPath } from '../proxy/client';
import { CATEGORIES, parseSummary, SLACK_MS, type Category, type SummaryEntry } from '../proxy/analyses';
import { cardFor } from './analysis';
import type { CamKey } from '../fleet';

// Issue #157: the moment a card's person, vehicle or pet was detected, for
// its thumbnail. cam-proxy keeps one event per AI type, starting at the second
// the camera's AI state for it turned on (measured 2026-10-03: 5 to 39 s into
// the recording, a median of about 8 s, while the old thumbnail was 2 s in,
// in the pre-record), and Vision analyses the still 1 s after that start.

export interface ProxyEvent {
  id: number;
  kind: Category;
  start: number;
  analysis: { stillTs: number; summary: SummaryEntry[] } | null;
}

const int = (v: unknown): v is number => Number.isSafeInteger(v);

// cam-proxy's GET /events answer: its person, vehicle and pet events (motion
// and anything malformed left out), each with its ok analysis, if any.
export function parseProxyEvents(body: unknown): ProxyEvent[] {
  return (Array.isArray(body) ? body : []).flatMap((x) => {
    const e = x as { id?: unknown; kind?: unknown; start?: unknown; analysis?: { status?: unknown; stillTs?: unknown; summary?: unknown } | null } | null;
    if (!e || !int(e.id) || !CATEGORIES.includes(e.kind as Category) || !int(e.start)) return [];
    const a = e.analysis;
    const analysis = a && a.status === 'ok' && int(a.stillTs) ? { stillTs: a.stillTs, summary: parseSummary(a.summary) } : null;
    return [{ id: e.id, kind: e.kind as Category, start: e.start, analysis }];
  });
}

// Whether Vision confirmed the event's own type on its analysed still.
const confirmed = (e: ProxyEvent): boolean => !!e.analysis?.summary.some((s) => s.category === e.kind);

// A card's thumbnail from its person, vehicle and pet events (Klaus,
// 2026-10-04): the still of the first event Vision confirmed the type of
// (then the other confirmed ones), else the second the first event was
// detected at, which is also the last resort. `version` names the choice
// (c<event id>: a confirmed event's still; d<event id>: a detection second),
// so it changes when an analysis arrives later. null without AI events.
export function thumbPlan(events: ProxyEvent[]): { version: string; moments: number[] } | null {
  if (!events.length) return null;
  const sorted = [...events].sort((a, b) => a.start - b.start || a.id - b.id);
  const yes = sorted.filter(confirmed);
  const first = sorted[0];
  const moments = [...new Set([...yes.map((e) => e.analysis!.stillTs), first.start])];
  return { version: yes.length ? `c${yes[0].id}` : `d${first.id}`, moments };
}

// The seconds to try for a card's thumbnail, best first (thumbPlan). An event
// counts for the card when it starts in [start − 5 s, end], as analyses do.
// Empty for motion-only cards.
export function detectionMoments(events: ProxyEvent[], start: number, end: number): number[] {
  return thumbPlan(events.filter((e) => e.start >= start - SLACK_MS && e.start <= end))?.moments ?? [];
}

// The person, vehicle and pet events from a card's cam-proxy that may be
// the card's (starting in [start − 5 s, end]): one request.
export async function proxyCardEvents(cameraId: CamKey, start: number, end: number): Promise<ProxyEvent[]> {
  const client = getProxyClient(cameraId);
  if (!client) return [];
  const body = await client.json<unknown>(proxyPath(cameraId, '/events'), { from: start - SLACK_MS, to: end, limit: 1000 });
  return parseProxyEvents(body).filter((e) => e.start >= start - SLACK_MS && e.start <= end);
}

// A day's person, vehicle and pet events per card (cards as unix ms spans),
// each event in one card only, the one its analysis would go to (cardFor),
// oldest first.
export function cardEvents(cards: { start: number; end: number }[], events: ProxyEvent[]): ProxyEvent[][] {
  const spans = cards.map((c) => ({ s: c.start, e: c.end }));
  const per = cards.map(() => [] as ProxyEvent[]);
  for (const e of [...events].sort((a, b) => a.start - b.start || a.id - b.id)) {
    const i = cardFor(spans, e.start);
    if (i >= 0) per[i].push(e);
  }
  return per;
}

// A card's events per AI type (Klaus, 2026-10-04: "Person 2x"); motion is never counted.
export function kindCounts(events: ProxyEvent[]): Partial<Record<Category, number>> {
  const counts: Partial<Record<Category, number>> = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return counts;
}

// The cards with their per-type counts and their thumbnail's version, where
// the proxy's events are known. `version` may add to the plan's (a retry).
export function attachAiEvents<T extends { id: string; start: string; end: string }>(
  cards: T[],
  events: ProxyEvent[] | null,
  version: (cardId: string, planned: string) => string = (_, v) => v,
): (T & { counts?: Partial<Record<Category, number>>; thumb?: string })[] {
  if (!events) return cards;
  const per = cardEvents(cards.map((c) => ({ start: Date.parse(c.start), end: Date.parse(c.end) })), events);
  return cards.map((c, i) => {
    const plan = thumbPlan(per[i]);
    return plan ? { ...c, counts: kindCounts(per[i]), thumb: version(c.id, plan.version) } : c;
  });
}
