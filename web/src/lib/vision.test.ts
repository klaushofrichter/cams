import { describe, expect, it } from 'vitest';
import { badges, subtypes, type CardAnalysis } from './vision';

const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.9 };
const an = (o: Partial<CardAnalysis> = {}): CardAnalysis => ({ best: {}, notConfirmed: [], stills: [], ...o });

describe('badges', () => {
  it('confirms a camera label with Vision’s score, and names the subtype in the tooltip', () => {
    const a = an({ best: { person: { score: 0.784, subtype: 'person' } }, stills: [{ eventId: 1, stillTs: 1, summary: [{ category: 'person', subtype: 'person', score: 0.784, box }] }] });
    expect(badges(['person', 'motion'], a)).toEqual([{ kind: 'agree', category: 'person', text: '✦ Vision 78%', title: 'Vision: person 0.78' }]);
  });

  it('says "not confirmed", keeping the camera’s label', () => {
    expect(badges(['person'], an({ notConfirmed: ['person'] }))).toEqual([
      { kind: 'not-confirmed', category: 'person', text: '✦ Vision: not confirmed', title: 'Vision found no person in the analysed still' },
    ]);
  });

  it('adds what Vision found and the camera did not label', () => {
    const a = an({ best: { pet: { score: 0.7, subtype: 'dog' } }, stills: [{ eventId: 1, stillTs: 1, summary: [{ category: 'pet', subtype: 'dog', score: 0.7, box }, { category: 'pet', subtype: 'cat', score: 0.55, box }] }] });
    expect(badges(['motion'], a)).toEqual([{ kind: 'extra', category: 'pet', text: '+ Pet 70%', title: 'Vision: dog 0.70, cat 0.55' }]);
  });

  it('shows nothing without an analysis, or when nothing was found or missed', () => {
    expect(badges(['person'], undefined)).toEqual([]);
    expect(badges(['motion'], an())).toEqual([]);
  });
});

describe('subtypes', () => {
  it('lists each subtype once with its best score, best first', () => {
    const s = (subtype: string, score: number) => ({ category: 'pet' as const, subtype, score, box });
    const a = an({ stills: [{ eventId: 1, stillTs: 1, summary: [s('cat', 0.5), s('dog', 0.6)] }, { eventId: 2, stillTs: 2, summary: [s('cat', 0.9)] }] });
    expect(subtypes(a, 'pet')).toBe('cat 0.90, dog 0.60');
  });
});
