// @vitest-environment jsdom
//
// Fix round 1, item 7: Live.svelte's mini-timeline events effect used to key
// its refresh-vs-fresh-load decision by camera id alone, so a local-midnight
// rollover (the date changes under `$todayDate`, id doesn't) looked exactly
// like a refresh -- keeping yesterday's clips drawn until the next poll
// happened to replace them. Keying by `${id}|${$todayDate}` makes the
// rollover a fresh load instead, clearing the old day's clips immediately.
// LiveEventsHarness.svelte mirrors that exact effect, driven by $state
// props, so this test doesn't need Live's camera/status/player dependencies.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import LiveEventsHarness from './testing/LiveEventsHarness.svelte';

type Snapshot = { events: string[] };
type Harness = { snapshot(): Snapshot };

let target: HTMLDivElement | undefined;
let component: Harness | undefined;

afterEach(() => {
  if (component) unmount(component as unknown as Record<string, unknown>);
  target?.remove();
  target = undefined;
  component = undefined;
});

describe('LiveEventsHarness (Live.svelte mini-timeline events effect)', () => {
  it('clears yesterday\'s clips at once when the date rolls over, instead of treating it as a refresh', async () => {
    target = document.createElement('div');
    document.body.appendChild(target);

    const resolvers = new Map<number, (events: string[]) => void>();
    const fetcher = (seq: number) =>
      new Promise<string[]>((resolve) => {
        resolvers.set(seq, resolve);
      });

    const props = $state({ id: 'cam1', date: '2026-01-15', fetcher });
    component = mount(LiveEventsHarness, { target, props }) as unknown as Harness;
    await Promise.resolve();

    // Yesterday's fetch (seq 1) resolves with some clips.
    resolvers.get(1)!(['yesterday-clip-a', 'yesterday-clip-b']);
    await Promise.resolve();
    await Promise.resolve();
    expect(component.snapshot().events).toEqual(['yesterday-clip-a', 'yesterday-clip-b']);

    // Local midnight rolls over: same camera, new date. This must clear the
    // old clips immediately (a fresh load), not wait for the new fetch to
    // resolve as if it were just a refresh of the same day.
    flushSync(() => {
      props.date = '2026-01-16';
    });
    expect(component.snapshot().events).toEqual([]);

    // Today's own (still-empty) fetch resolves.
    resolvers.get(2)!([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(component.snapshot().events).toEqual([]);
  });
});
