import { CATEGORIES, SLACK_MS, type Category, type ProxyAnalysis, type SummaryEntry } from '../proxy/analyses';
import type { StillCheck } from '../proxy/stillChecks';

// Vision's word on a card (spec 2026-09-30-analytics-in-cams-design): the best
// score per category over the card's ok analyses, the camera's AI labels that
// an analysis of that kind did not find, and the analysed stills, each with
// its analysed event's kind (which "not confirmed" it covers, issue #113).
export interface CardAnalysis {
  best: Partial<Record<Category, { score: number; subtype: string }>>;
  notConfirmed: Category[];
  // `checkId`: a still check (cams #179), picked by hand; its kind is "check".
  stills: { eventId: number; kind: string; stillTs: number; summary: SummaryEntry[]; checkId?: number }[];
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

// The card a still check belongs to (spec 2026-10-04-still-checks-ui-design,
// ruling 8): the one whose span holds its second, no slack; of two, the
// latest that had started.
export function cardHolding(cards: { s: number; e: number }[], ts: number): number {
  let best = -1;
  cards.forEach((c, i) => {
    if (ts >= c.s && ts <= c.e && (best < 0 || c.s > cards[best].s)) best = i;
  });
  return best;
}

// Still checks only confirm (cams #179, design ruling 5): a category the
// check found that is one of the card's labels counts for `best`, like an
// automatic analysis; any other category is left out, and a check never makes
// a label "not confirmed". A check joins the card's stills (its Vision
// dialog) when the card has an analysis anyway or the check confirms one.
export function attachAnalyses<T extends { start: string; end: string; triggers: readonly string[] }>(cards: T[], analyses: ProxyAnalysis[], checks: StillCheck[] = []): (T & { analysis?: CardAnalysis })[] {
  const spans = cards.map((c) => ({ s: Date.parse(c.start), e: Date.parse(c.end) }));
  const per = cards.map(() => [] as ProxyAnalysis[]);
  const checksOf = cards.map(() => [] as StillCheck[]);
  for (const a of analyses) {
    if (a.status !== 'ok') continue;
    const i = cardFor(spans, a.start);
    if (i >= 0) per[i].push(a);
  }
  for (const k of checks) {
    if (k.id === null) continue;
    const i = cardHolding(spans, k.stillTs);
    if (i >= 0) checksOf[i].push(k);
  }
  return cards.map((c, i) => {
    const list = per[i];
    const confirming = checksOf[i].filter((k) => k.summary.some((s) => c.triggers.includes(s.category)));
    if (!list.length && !confirming.length) return c;
    const best: CardAnalysis['best'] = {};
    const consider = (s: SummaryEntry) => {
      const b = best[s.category];
      if (!b || s.score > b.score) best[s.category] = { score: s.score, subtype: s.subtype };
    };
    for (const a of list) for (const s of a.summary) consider(s);
    const notConfirmed = CATEGORIES.filter((k) => c.triggers.includes(k) && !best[k] && list.some((a) => a.kind === k));
    for (const k of checksOf[i]) for (const s of k.summary) if (c.triggers.includes(s.category)) consider(s);
    const stills: CardAnalysis['stills'] = list.filter((a) => a.stillTs !== null).map((a) => ({ eventId: a.eventId, kind: a.kind, stillTs: a.stillTs as number, summary: a.summary }));
    for (const k of checksOf[i]) stills.push({ eventId: k.eventId ?? 0, kind: 'check', stillTs: k.stillTs, summary: k.summary, checkId: k.id as number });
    stills.sort((x, y) => x.stillTs - y.stillTs);
    return { ...c, analysis: { best, notConfirmed: notConfirmed.filter((k) => !best[k]), stills } };
  });
}
