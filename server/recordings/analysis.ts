import { CATEGORIES, SLACK_MS, type Category, type ProxyAnalysis, type SummaryEntry } from '../proxy/analyses';

// Vision's word on a card (spec 2026-09-30-analytics-in-cams-design): the best
// score per category over the card's ok analyses, the camera's AI labels that
// an analysis of that kind did not find, and the analysed stills, each with
// its analysed event's kind (which "not confirmed" it covers, issue #113).
export interface CardAnalysis {
  best: Partial<Record<Category, { score: number; subtype: string }>>;
  notConfirmed: Category[];
  stills: { eventId: number; kind: string; stillTs: number; summary: SummaryEntry[] }[];
}

// The card an analysis belongs to: its event starts in [card start − 5 s,
// card end]. Where two cards fit (a clip repeats the previous one's last
// seconds), the latest one that had already started wins, else the earliest.
export function cardFor(cards: { s: number; e: number }[], start: number): number {
  const hits = cards.map((c, i) => ({ ...c, i })).filter((c) => start >= c.s - SLACK_MS && start <= c.e);
  const started = hits.filter((c) => c.s <= start);
  if (started.length) return started.reduce((x, y) => (y.s > x.s ? y : x)).i;
  return hits.length ? hits.reduce((x, y) => (y.s < x.s ? y : x)).i : -1;
}

export function attachAnalyses<T extends { start: string; end: string; triggers: readonly string[] }>(cards: T[], analyses: ProxyAnalysis[]): (T & { analysis?: CardAnalysis })[] {
  const spans = cards.map((c) => ({ s: Date.parse(c.start), e: Date.parse(c.end) }));
  const per = cards.map(() => [] as ProxyAnalysis[]);
  for (const a of analyses) {
    if (a.status !== 'ok') continue;
    const i = cardFor(spans, a.start);
    if (i >= 0) per[i].push(a);
  }
  return cards.map((c, i) => {
    const list = per[i];
    if (!list.length) return c;
    const best: CardAnalysis['best'] = {};
    for (const a of list) {
      for (const s of a.summary) {
        const b = best[s.category];
        if (!b || s.score > b.score) best[s.category] = { score: s.score, subtype: s.subtype };
      }
    }
    const notConfirmed = CATEGORIES.filter((k) => c.triggers.includes(k) && !best[k] && list.some((a) => a.kind === k));
    const stills = list.filter((a) => a.stillTs !== null).map((a) => ({ eventId: a.eventId, kind: a.kind, stillTs: a.stillTs as number, summary: a.summary }));
    return { ...c, analysis: { best, notConfirmed, stills } };
  });
}
