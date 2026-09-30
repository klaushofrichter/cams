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
  stills: { eventId: number; stillTs: number; summary: SummaryEntry[] }[];
}
export interface Badge { kind: 'agree' | 'not-confirmed' | 'extra'; category: Category; text: string; title: string }

const LABEL: Record<Category, string> = { person: 'Person', vehicle: 'Vehicle', pet: 'Pet' };
const pct = (s: number) => `${Math.round(s * 100)}%`;

// Every subtype Vision saw for a category, each once with its best score,
// best first: "dog 0.70, cat 0.55".
export function subtypes(a: CardAnalysis, k: Category): string {
  const best = new Map<string, number>();
  for (const s of a.stills) for (const e of s.summary) if (e.category === k && e.score > (best.get(e.subtype) ?? -1)) best.set(e.subtype, e.score);
  return [...best].sort((x, y) => y[1] - x[1]).map(([n, v]) => `${n} ${v.toFixed(2)}`).join(', ');
}

// Per category: Vision agrees with the camera's label (its score), found none
// where the camera said so ("not confirmed"), or found one the camera did not
// label ("+ Pet 70%").
export function badges(triggers: readonly string[], a: CardAnalysis | undefined): Badge[] {
  if (!a) return [];
  const out: Badge[] = [];
  for (const k of CATEGORIES) {
    const b = a.best[k];
    if (b && triggers.includes(k)) out.push({ kind: 'agree', category: k, text: `✦ Vision ${pct(b.score)}`, title: `Vision: ${subtypes(a, k)}` });
    else if (a.notConfirmed.includes(k)) out.push({ kind: 'not-confirmed', category: k, text: '✦ Vision: not confirmed', title: `Vision found no ${k} in the analysed still` });
    else if (b) out.push({ kind: 'extra', category: k, text: `+ ${LABEL[k]} ${pct(b.score)}`, title: `Vision: ${subtypes(a, k)}` });
  }
  return out;
}
