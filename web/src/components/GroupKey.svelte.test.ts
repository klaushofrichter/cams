// @vitest-environment jsdom
//
// Fix round 1, item 2: EventList's and DownloadList's hour-group open/closed
// state used to be keyed by `date|hour` only, so switching cameras (without
// changing the date) could carry a manually-opened busy group's state over
// to a different camera's same hour, which has nothing to do with it. The
// key is now `cameraId|date|hour`.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import EventList from './EventList.svelte';
import DownloadList from './DownloadList.svelte';
import { makeEvents } from './testing/eventFixtures';

const DATE = '2026-09-26';

let target: HTMLDivElement | undefined;
let component: Record<string, unknown> | undefined;

afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  target = undefined;
  component = undefined;
});

describe('hour-group state is keyed per camera', () => {
  it('EventList: camera B\'s busy 14:00 group starts collapsed after switching from camera A', () => {
    target = document.createElement('div');
    document.body.appendChild(target);

    const props = $state({
      cameraId: 'camA',
      events: makeEvents(DATE, 14, 3), // 3 clips: open by default (<= COLLAPSE_OVER)
      filter: 'all' as const,
      date: DATE,
      selectedId: null as string | null,
      onfilter: () => {},
      onselect: () => {},
    });
    component = mount(EventList, { target, props }) as unknown as Record<string, unknown>;

    // Camera A's group is open (3 clips, default open).
    let toggle = target.querySelector<HTMLElement>('[data-testid="hour-toggle"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    // Switch to camera B with a busy 14:00 hour (20 > COLLAPSE_OVER): if the
    // group key didn't include the camera id, this key (`14:00`) would
    // already exist in groupOpen from camera A above and stay open.
    flushSync(() => {
      props.cameraId = 'camB';
      props.events = makeEvents(DATE, 14, 20);
    });

    toggle = target.querySelector<HTMLElement>('[data-testid="hour-toggle"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('DownloadList: camera B\'s busy 14:00 group starts collapsed after switching from camera A', () => {
    target = document.createElement('div');
    document.body.appendChild(target);

    const props = $state({
      cameraId: 'camA',
      events: makeEvents(DATE, 14, 3),
      date: DATE,
      selectedId: null as string | null,
    });
    component = mount(DownloadList, { target, props }) as unknown as Record<string, unknown>;

    let toggle = target.querySelector<HTMLElement>('[data-testid="hour-toggle"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    flushSync(() => {
      props.cameraId = 'camB';
      props.events = makeEvents(DATE, 14, 20);
    });

    toggle = target.querySelector<HTMLElement>('[data-testid="hour-toggle"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });
});
