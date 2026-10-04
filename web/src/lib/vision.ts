// cam-proxy's Vision results as cams shows them (spec
// 2026-09-30-analytics-in-cams-design): a badge per category on a card.
// The camera's labels stay as they are; Vision adds its confidence.

export type Category = 'person' | 'vehicle' | 'pet';
export const CATEGORIES: Category[] = ['person', 'vehicle', 'pet'];
export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface SummaryEntry { category: Category; subtype: string; score: number; box: Box }
export interface StillObject { name: string; score: number; box: Box | null }
export interface CardAnalysis {
  best: Partial<Record<Category, { score: number; subtype: string }>>;
  notConfirmed: Category[];
  // `kind`: the analysed event's kind (issue #113); older servers don't send it.
  // `checkId`: a still check (cams #179), kind "check".
  stills: { eventId: number; kind?: string; stillTs: number; summary: SummaryEntry[]; checkId?: number }[];
}
export type Level = 'high' | 'mid' | 'low';
export interface Badge { kind: 'agree' | 'not-confirmed' | 'extra'; category: Category; level: Level | null; text: string; title: string; label: string }

export const LABEL: Record<Category, string> = { person: 'Person', vehicle: 'Vehicle', pet: 'Pet' };
const percent = (s: number) => Math.round(s * 100);
export const pct = (s: number) => `${percent(s)}%`;
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// The label next to a box (Klaus, 2026-10-01): "Clothing 56%", only the first
// letter capitalised ("Ceiling fan 90%").
export const boxLabel = (name: string, score: number) => `${capital(name)} ${pct(score)}`;
// A line of the dialog's findings (Klaus, 2026-10-01): "Person - 61% Confidence".
export const findingLine = (subtype: string, score: number) => `${capital(subtype)} - ${pct(score)} Confidence`;

// The badge's colour (Klaus, 2026-09-30): the percent it shows decides, so
// 0.795 ("80%") is high and 0.494 ("49%") is low.
export function confidenceLevel(score: number): Level {
  const p = percent(score);
  return p >= 80 ? 'high' : p >= 50 ? 'mid' : 'low';
}
const BAND: Record<Level, string> = { high: 'high confidence', mid: 'medium confidence', low: 'low confidence' };
const SHOW = 'Show the analysed still';
// `label`: the badge's accessible name, saying what a click does.
// The tooltip names the stills' subtypes, else (no still carries the
// category) the best one's.
const scored = (a: CardAnalysis, k: Category, best: { score: number; subtype: string }, what: string) => {
  const level = confidenceLevel(best.score);
  const seen = subtypes(a, k) || boxLabel(best.subtype, best.score);
  return { level, title: `Vision: ${seen} · ${BAND[level]}`, label: `${what} ${pct(best.score)}, ${BAND[level]}. ${SHOW}` };
};

// Every subtype Vision saw for a category, each once with its best score,
// best first, written like a box's label: "Dog 70%, Cat 55%".
export function subtypes(a: CardAnalysis, k: Category): string {
  const best = new Map<string, number>();
  for (const s of a.stills) for (const e of s.summary) if (e.category === k && e.score > (best.get(e.subtype) ?? -1)) best.set(e.subtype, e.score);
  return [...best].sort((x, y) => y[1] - x[1]).map(([n, v]) => boxLabel(n, v)).join(', ');
}

// Per category: Vision agrees with the camera's label (its score), found none
// where the camera said so ("not confirmed"), or found one the camera did not
// label ("+ Pet 70%").
export function badges(triggers: readonly string[], a: CardAnalysis | undefined): Badge[] {
  if (!a) return [];
  const out: Badge[] = [];
  for (const k of CATEGORIES) {
    const b = a.best[k];
    if (b && triggers.includes(k)) out.push({ kind: 'agree', category: k, text: `✦ Vision ${pct(b.score)}`, ...scored(a, k, b, 'Vision') });
    else if (a.notConfirmed.includes(k)) out.push({ kind: 'not-confirmed', category: k, level: null, text: '✦ Vision: not confirmed', title: `Vision found no ${k} in the analysed still`, label: `Vision: ${k} not confirmed. ${SHOW}` });
    else if (b) out.push({ kind: 'extra', category: k, text: `+ ${LABEL[k]} ${pct(b.score)}`, ...scored(a, k, b, `Vision also found ${LABEL[k]}`) });
  }
  return out;
}
