// @vitest-environment jsdom
//
// Fix round 1, item 1: Recordings.svelte's events effect used to leave the
// skeleton up forever when a refresh raced the first load -- a dropped,
// late response from the first load left `loading` stuck true because the
// refresh path only ever cleared it when the sequence numbers matched.
// EventsLoaderHarness.svelte mirrors that exact key/isRefresh/seq pattern
// (now fixed) with $state props, so this test can race a refresh against
// the first load without mounting the whole Recordings page and its stores,
// router and API layer.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import EventsLoaderHarness from './testing/EventsLoaderHarness.svelte';

type Snapshot = { loading: boolean; failed: boolean };
type Harness = { snapshot(): Snapshot };

let target: HTMLDivElement | undefined;
let component: Harness | undefined;

afterEach(() => {
  if (component) unmount(component as unknown as Record<string, unknown>);
  target?.remove();
  target = undefined;
  component = undefined;
});

describe('EventsLoaderHarness (Recordings.svelte events effect)', () => {
  it('clears the skeleton on a later successful refresh, even though the first load response is dropped', async () => {
    target = document.createElement('div');
    document.body.appendChild(target);

    // Deferred promises the test resolves by hand, keyed by sequence
    // number, so the exact race (first load still pending when a refresh
    // fires, then the first load's own response arriving even later) is
    // fully under this test's control.
    const resolvers = new Map<number, () => void>();
    const fetcher = (seq: number) =>
      new Promise<void>((resolve) => {
        resolvers.set(seq, resolve);
      });

    const props = $state({ loadKey: 'cam1|2026-09-26', refreshTick: 0, fetcher });
    component = mount(EventsLoaderHarness, { target, props }) as unknown as Harness;

    // The first load (seq 1) is in flight; the skeleton is up.
    expect(component.snapshot()).toEqual({ loading: true, failed: false });

    // A refresh races it (same key, same effect run -> isRefresh -> seq 2).
    flushSync(() => {
      props.refreshTick++;
    });
    expect(component.snapshot()).toEqual({ loading: true, failed: false });

    // The refresh (seq 2) resolves first: the skeleton must come down.
    resolvers.get(2)!();
    await Promise.resolve();
    await Promise.resolve();
    expect(component.snapshot()).toEqual({ loading: false, failed: false });

    // The first load's response (seq 1) finally arrives, dropped as stale:
    // it must not undo the state the refresh already settled.
    resolvers.get(1)!();
    await Promise.resolve();
    await Promise.resolve();
    expect(component.snapshot()).toEqual({ loading: false, failed: false });
  });
});
