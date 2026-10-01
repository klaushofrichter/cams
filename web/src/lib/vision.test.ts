import { describe, expect, it } from 'vitest';
import { badges, confidenceLevel, subtypes, type CardAnalysis } from './vision';

const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };
const an = (o: Partial<CardAnalysis> = {}): CardAnalysis => ({ best: {}, notConfirmed: [], stills: [], ...o });

describe('badges', () => {
  it('confirms a camera label with Vision’s score, and names the subtype in the tooltip', () => {
    const a = an({ best: { person: { score: 0.784, subtype: 'person' } }, stills: [{ eventId: 1, stillTs: 1, summary: [{ category: 'person', subtype: 'person', score: 0.784, box }] }] });
    expect(badges(['person', 'motion'], a)).toEqual([{ kind: 'agree', category: 'person', level: 'mid', text: '✦ Vision 78%', title: 'Vision: person 0.78 · medium confidence', label: 'Vision 78%, medium confidence. Show the analysed still' }]);
  });

  it('says "not confirmed", keeping the camera’s label', () => {
    expect(badges(['person'], an({ notConfirmed: ['person'] }))).toEqual([
      { kind: 'not-confirmed', category: 'person', level: null, text: '✦ Vision: not confirmed', title: 'Vision found no person in the analysed still', label: 'Vision: person not confirmed. Show the analysed still' },
    ]);
  });

  it('adds what Vision found and the camera did not label', () => {
    const a = an({ best: { pet: { score: 0.7, subtype: 'dog' } }, stills: [{ eventId: 1, stillTs: 1, summary: [{ category: 'pet', subtype: 'dog', score: 0.7, box }, { category: 'pet', subtype: 'cat', score: 0.55, box }] }] });
    expect(badges(['motion'], a)).toEqual([{ kind: 'extra', category: 'pet', level: 'mid', text: '+ Pet 70%', title: 'Vision: dog 0.70, cat 0.55 · medium confidence', label: 'Vision also found Pet 70%, medium confidence. Show the analysed still' }]);
  });

  it('shows nothing without an analysis, or when nothing was found or missed', () => {
    expect(badges(['person'], undefined)).toEqual([]);
    expect(badges(['motion'], an())).toEqual([]);
  });
});

describe('confidenceLevel', () => {
  // The shown percent decides: 0.495 shows 50% and is mid, 0.795 shows 80% and is high.
  it.each([
    [0.494, 'low'],
    [0.495, 'mid'],
    [0.5, 'mid'],
    [0.794, 'mid'],
    [0.795, 'high'],
    [0.8, 'high'],
    [0, 'low'],
    [1, 'high'],
  ] as const)('%s → %s', (score, level) => {
    expect(confidenceLevel(score)).toBe(level);
  });
});

describe('badge levels', () => {
  const one = (category: 'person' | 'pet', score: number) => an({ best: { [category]: { score, subtype: category } }, stills: [{ eventId: 1, stillTs: 1, summary: [{ category, subtype: category, score, box }] }] });

  it('colours an agreement by its score, and names the band in the tooltip', () => {
    expect(badges(['person'], one('person', 0.89))[0]).toMatchObject({ kind: 'agree', level: 'high', title: 'Vision: person 0.89 · high confidence', label: 'Vision 89%, high confidence. Show the analysed still' });
    expect(badges(['person'], one('person', 0.42))[0]).toMatchObject({ kind: 'agree', level: 'low', title: 'Vision: person 0.42 · low confidence' });
  });

  it('colours an extra finding the same way', () => {
    expect(badges(['motion'], one('pet', 0.81))[0]).toMatchObject({ kind: 'extra', level: 'high', title: 'Vision: pet 0.81 · high confidence' });
    expect(badges(['motion'], one('pet', 0.3))[0]).toMatchObject({ kind: 'extra', level: 'low', label: 'Vision also found Pet 30%, low confidence. Show the analysed still' });
  });

  it('gives "not confirmed" no level', () => {
    expect(badges(['person'], an({ notConfirmed: ['person'] }))[0].level).toBeNull();
  });
});

describe('subtypes', () => {
  it('lists each subtype once with its best score, best first', () => {
    const s = (subtype: string, score: number) => ({ category: 'pet' as const, subtype, score, box });
    const a = an({ stills: [{ eventId: 1, stillTs: 1, summary: [s('cat', 0.5), s('dog', 0.6)] }, { eventId: 2, stillTs: 2, summary: [s('cat', 0.9)] }] });
    expect(subtypes(a, 'pet')).toBe('cat 0.90, dog 0.60');
  });
});
