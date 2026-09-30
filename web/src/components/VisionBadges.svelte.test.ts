// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import VisionBadges from './VisionBadges.svelte';
import type { CardAnalysis } from '../lib/vision';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
});

function render(props: { triggers: string[]; analysis?: CardAnalysis }) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(VisionBadges, { target, props });
  flushSync();
  return [...target.querySelectorAll('[data-testid="vision-badge"]')].map((b) => ({ kind: b.getAttribute('data-kind'), text: b.textContent, title: b.getAttribute('title') }));
}

describe('VisionBadges', () => {
  it('renders the agreement and the extra finding', () => {
    const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
    const got = render({
      triggers: ['person'],
      analysis: { best: { person: { score: 0.84, subtype: 'person' }, pet: { score: 0.7, subtype: 'dog' } }, notConfirmed: [], stills: [{ eventId: 1, stillTs: 1, summary: [{ category: 'person', subtype: 'person', score: 0.84, box }, { category: 'pet', subtype: 'dog', score: 0.7, box }] }] },
    });
    expect(got).toEqual([
      { kind: 'agree', text: '✦ Vision 84%', title: 'Vision: person 0.84' },
      { kind: 'extra', text: '+ Pet 70%', title: 'Vision: dog 0.70' },
    ]);
  });

  it('renders nothing without an analysis', () => {
    expect(render({ triggers: ['person'] })).toEqual([]);
  });
});
