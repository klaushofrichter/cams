// web/src/components/ArchiveStep.svelte.test.ts
// @vitest-environment jsdom
// The Save dialog's archive step (cams spec 2026-10-05-archive-design).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArchiveStep from './ArchiveStep.svelte';

const JOB = 'J'.repeat(22);
const item = { via: 'den', id: 12, name: 'Fox at the door', bytes: 4_100_000, labels: ['Person'], urls: {} };
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
let calls: { url: string; method: string; body: unknown }[] = [];
beforeEach(() => {
  calls = [];
  history.replaceState({}, '', '/app/video');
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
// fetch answers by method and path.
function serve(answer: (url: string, method: string) => [number, unknown]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const [status, body] = answer(url, method);
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }));
}
function render(props: Partial<{ kinds: string[]; size: string; thumbnailAt: number; source: unknown }> = {}) {
  const oncancel = vi.fn(), onclose = vi.fn();
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ArchiveStep, {
    target,
    props: { camera: 'den', cameraName: 'Den', source: { type: 'composition', id: JOB }, recordedFrom: Date.parse('2026-10-05T14:03:22-05:00'), kinds: ['motion', 'person'], size: 'sd', oncancel, onclose, ...props } as never,
  });
  flushSync();
  return { oncancel, onclose };
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const chip = (l: string) => target!.querySelector(`[data-testid="label-chip"][data-label="${l}"]`) as HTMLButtonElement;
const type = (id: string, v: string) => {
  const el = q(id) as HTMLInputElement;
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
const click = (id: string) => {
  q(id)!.click();
  flushSync();
};

describe('ArchiveStep', () => {
  it('starts with the default name, a year, and the clip’s kinds and size as labels', () => {
    serve(() => [500, {}]);
    render();
    expect((q('archive-name') as HTMLInputElement).value).toBe('2026-10-05 14:03:22 Den');
    expect((q('archive-retention-days') as HTMLInputElement).value).toBe('365');
    expect((q('archive-retention-forever') as HTMLInputElement).checked).toBe(false);
    expect(chip('Person').getAttribute('aria-pressed')).toBe('true');
    expect(chip('SD').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Pet').getAttribute('aria-pressed')).toBe('false');
    expect(chip('4K').getAttribute('aria-pressed')).toBe('false');
  });

  it('archives at once (201): the name only when edited, forever, custom labels; done offers the Archive', async () => {
    serve(() => [201, { id: JOB, via: 'den', state: 'done', progress: 1, item }]);
    const { onclose } = render({ thumbnailAt: 1_759_690_000_000 });
    q('archive-retention-forever')!.click();
    flushSync();
    chip('Pet').click();
    chip('Person').click(); // off
    type('label-input', 'fox');
    click('label-add');
    expect(target!.querySelector('[data-testid="label-custom"]')!.textContent).toContain('fox');
    click('archive-submit');
    await vi.waitFor(() => expect(q('archive-done')).not.toBeNull());
    expect(calls[0]).toEqual({ url: '/api/cameras/den/archive', method: 'POST', body: { source: { type: 'composition', id: JOB }, labels: ['SD', 'Pet', 'fox'], retentionDays: null, thumbnailAt: 1_759_690_000_000 } });
    expect(q('archive-done')!.textContent).toBe('Archived as “Fox at the door” (4.1 MB).');
    click('archive-open');
    expect(onclose).toHaveBeenCalled();
    expect(location.pathname + location.search).toBe('/app/archive?item=den%3A12');
  });

  it('sends an edited name, trimmed', async () => {
    serve(() => [201, { id: JOB, via: 'den', state: 'done', progress: 1, item }]);
    render();
    type('archive-name', '  Fox at the door ');
    click('archive-submit');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toMatchObject({ name: 'Fox at the door' });
  });

  it('refuses what the proxy would: an empty name, a bad label, a bad retention', () => {
    serve(() => [500, {}]);
    render();
    type('archive-name', '  ');
    expect(q('archive-problem')!.textContent).toBe('The name can’t be empty.');
    expect((q('archive-submit') as HTMLButtonElement).disabled).toBe(true);
    type('archive-name', 'ok');
    type('archive-retention-days', '0');
    expect((q('archive-submit') as HTMLButtonElement).disabled).toBe(true);
    type('archive-retention-days', '30');
    expect((q('archive-submit') as HTMLButtonElement).disabled).toBe(false);
    type('label-input', 'two words');
    click('label-add');
    expect(q('label-error')!.textContent).toBe('A label is one word: letters and digits only.');
    expect(calls).toHaveLength(0);
  });

  it('shows the progress of a longer job (202), polls it, and ends done', async () => {
    let polls = 0;
    serve((url, method) => {
      if (method === 'POST') return [202, { id: JOB, via: 'den', state: 'running', phase: 'fetching', progress: 0.25, bytes: 25_000_000, size: 100_000_000, item: null }];
      polls++;
      return polls < 2 ? [200, { id: JOB, via: 'den', state: 'running', phase: 'copying', progress: 0.5, bytes: 50_000_000, size: 100_000_000, item: null }] : [200, { id: JOB, via: 'den', state: 'done', progress: 1, item }];
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    render();
    click('archive-submit');
    await vi.waitFor(() => expect(q('archive-progress-text')?.textContent).toBe('Fetching the recording from the camera… 25.0 MB of 100.0 MB'));
    expect(q('archive-progress')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(q('archive-progress-text')!.textContent).toBe('Copying… 50.0 MB of 100.0 MB'));
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(q('archive-done')).not.toBeNull());
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.url)).toEqual([`/api/archive/den/jobs/${JOB}`, `/api/archive/den/jobs/${JOB}`]);
  });

  // Review of #205: a poll answered after the dialog closed armed the timer again, for good.
  it('stops polling when it goes away, also with a poll still on its way', async () => {
    let release: (() => void) | undefined;
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
      if (init.method === 'POST') return new Response(JSON.stringify({ id: JOB, via: 'den', state: 'queued', progress: 0, item: null }), { status: 202 });
      polls++;
      await new Promise<void>((r) => (release = r));
      return new Response(JSON.stringify({ id: JOB, via: 'den', state: 'running', progress: 0.5, item: null }), { status: 200 });
    }));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    render();
    click('archive-submit');
    await vi.waitFor(() => expect(q('archive-cancel-job')).not.toBeNull());
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(polls).toBe(1));
    unmount(component!);
    component = undefined;
    release!();
    await new Promise((r) => setTimeout(r, 0));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls).toBe(1);
  });

  it('cancels a running job and goes back to the form', async () => {
    serve((_url, method) => (method === 'POST' ? [202, { id: JOB, via: 'den', state: 'queued', progress: 0, item: null }] : [204, null]));
    render();
    click('archive-submit');
    await vi.waitFor(() => expect(q('archive-cancel-job')).not.toBeNull());
    click('archive-cancel-job');
    expect(calls.at(-1)).toMatchObject({ url: `/api/archive/den/jobs/${JOB}`, method: 'DELETE' });
    expect(q('archive-error')!.textContent).toBe('Archiving was cancelled.');
    expect(q('archive-submit')).not.toBeNull();
  });

  it('says insufficient space with the sizes, and a failed job in words', async () => {
    serve(() => [507, { error: 'insufficient_space', needed: 4_000_000_000, free: 5_000_000_000, minFreeBytes: 2_147_483_648 }]);
    render();
    click('archive-submit');
    await vi.waitFor(() => expect(q('archive-error')).not.toBeNull());
    expect(q('archive-error')!.textContent).toBe('Not enough space on the cam-proxy: the clip needs 4.0 GB, 5.0 GB is free, and 2.1 GB must stay free.');
    expect((q('archive-submit') as HTMLButtonElement).disabled).toBe(false); // try again, or Cancel
    serve(() => [202, { id: JOB, via: 'den', state: 'failed', error: 'camera_offline', progress: 0, item: null }]);
    click('archive-submit');
    await vi.waitFor(() => expect(q('archive-error')!.textContent).toBe('The camera is offline, and the recording isn’t cached on the cam-proxy.'));
  });

  it('Cancel goes back to the Save dialog', () => {
    serve(() => [500, {}]);
    const { oncancel } = render();
    click('archive-cancel');
    expect(oncancel).toHaveBeenCalled();
  });
});
