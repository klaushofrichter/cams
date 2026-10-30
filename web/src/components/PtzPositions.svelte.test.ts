// @vitest-environment jsdom
// The PTZ panel's saved positions (cam-proxy spec 2026-10-30-ptz-capabilities-design
// §5.2, §8.2): click to go, Home starred, Make Home, sort, rename and delete
// inline (no browser dialogs), Save position; the list never blanks while
// it reloads.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PtzPanel from './PtzPanel.svelte';
import type { PtzCapabilities, PtzPosition } from '../lib/ptz';

const ptzListeners = new Set<(cam: string) => void>();
vi.mock('../lib/eventStream', () => ({
  eventStream: () => ({
    onPtzPositions: (fn: (cam: string) => void) => {
      ptzListeners.add(fn);
      return () => ptzListeners.delete(fn);
    },
  }),
}));

const CAPS: PtzCapabilities = { move: true, zoom: true, focus: false, speed: true, positions: { max: 20 } };

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
let calls: { url: string; method: string; body: unknown }[];
let list: PtzPosition[];
let max: number;
let hold: Promise<void> | null; // GET positions waits for this
let nextId: number;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const pos = (n: number, name: string, extra: Partial<PtzPosition> = {}): PtzPosition => ({ id: `pos_${n}`, name, order: n - 1, home: n === 1, state: 'ok', ...extra });

// cam-proxy's positions, in memory (the shapes of its answers).
async function server(url: string, method: string, body: Record<string, unknown> | undefined): Promise<Response> {
  const path = url.replace(/^\/api\/cameras\/[^/]+\/ptz/, '');
  const find = (id: string) => list.find((p) => p.id === id);
  if (path === '/positions' && method === 'GET') {
    if (hold) await hold;
    return json(200, { max, positions: list.map((p) => ({ ...p })) });
  }
  if (path === '/positions' && method === 'POST') {
    const p = pos(nextId++, String(body!.name), { order: list.length, home: list.length === 0 });
    list.push(p);
    return json(201, p);
  }
  if (path === '/positions/order' && method === 'PUT') {
    const ids = body!.ids as string[];
    list = ids.map((id, order) => ({ ...find(id)!, order }));
    return json(200, { max, positions: list });
  }
  let m = /^\/positions\/([^/]+)$/.exec(path);
  if (m && method === 'PATCH') {
    const p = find(m[1])!;
    if (body!.name !== undefined) p.name = String(body!.name);
    if (body!.home === true) for (const x of list) x.home = x === p;
    return json(200, p);
  }
  if (m && method === 'DELETE') {
    list = list.filter((p) => p.id !== m![1]).map((p, order) => ({ ...p, order }));
    return new Response(null, { status: 204 });
  }
  m = /^\/positions\/([^/]+)\/(save|go)$/.exec(path);
  if (m && m[2] === 'save') {
    const p = find(m[1])!;
    p.state = 'ok';
    return json(200, p);
  }
  if (m && m[2] === 'go') return find(m[1])!.state === 'missing' ? json(409, { error: 'position_missing' }) : new Response(null, { status: 204 });
  return new Response(null, { status: 204 });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem('cams-ptz-open', '1');
  ptzListeners.clear();
  calls = [];
  max = 20;
  hold = null;
  nextId = 4;
  list = [pos(1, 'Gate'), pos(2, 'Door'), pos(3, 'Drive')];
  vi.stubGlobal('fetch', vi.fn(backend));
});

// The stubbed fetch: records each call, answers from server().
async function backend(url: string, init: RequestInit = {}): Promise<Response> {
  const body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
  calls.push({ url, method: init.method ?? 'GET', body });
  return server(url, init.method ?? 'GET', body);
}
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
  }
}
async function render(caps: PtzCapabilities = CAPS, cameraId = 'den') {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(PtzPanel, { target, props: { cameraId, ptz: caps } });
  await settle();
  return target;
}
const q = (id: string, root: ParentNode = target!) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const rows = () => [...target!.querySelectorAll('[data-testid="ptz-row"]')] as HTMLElement[];
const row = (id: string) => target!.querySelector(`[data-testid="ptz-row"][data-id="${id}"]`) as HTMLElement;
const names = () => rows().map((r) => q('ptz-go', r)?.textContent?.trim() ?? r.querySelector('.name')?.textContent?.trim());
const writes = () => calls.filter((c) => c.method !== 'GET');
const type = (el: HTMLElement, value: string) => {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
async function click(el: HTMLElement | null) {
  el!.click();
  await settle();
}

describe('PtzPanel positions', () => {
  it('lists positions in order with a star on Home', async () => {
    await render();
    expect(names()).toEqual(['Gate', 'Door', 'Drive']);
    expect(rows().map((r) => r.dataset.id)).toEqual(['pos_1', 'pos_2', 'pos_3']);
    expect(q('ptz-home-mark', row('pos_1'))!.getAttribute('aria-label')).toBe('Home');
    expect(q('ptz-home-mark', row('pos_2'))).toBeNull();
    expect(q('ptz-make-home', row('pos_1'))).toBeNull();
    expect(q('ptz-make-home', row('pos_2'))).not.toBeNull();
  });

  it('loads nothing while the panel is closed, and loads on opening', async () => {
    localStorage.setItem('cams-ptz-open', '0');
    await render();
    expect(calls).toEqual([]);
    await click(q('ptz-toggle'));
    expect(calls.map((c) => c.url)).toEqual(['/api/cameras/den/ptz/positions']);
    expect(names()).toEqual(['Gate', 'Door', 'Drive']);
  });

  it('shows no positions part for a camera that cannot store positions', async () => {
    await render({ ...CAPS, positions: null });
    expect(q('ptz-positions')).toBeNull();
    expect(q('ptz-save')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('click on a name goes there', async () => {
    await render();
    await click(q('ptz-go', row('pos_2')));
    expect(writes()).toEqual([{ url: '/api/cameras/den/ptz/positions/pos_2/go', method: 'POST', body: {} }]);
  });

  it('Make Home patches home: true and moves the star', async () => {
    await render();
    await click(q('ptz-make-home', row('pos_3')));
    expect(writes()).toEqual([{ url: '/api/cameras/den/ptz/positions/pos_3', method: 'PATCH', body: { home: true } }]);
    expect(q('ptz-home-mark', row('pos_3'))).not.toBeNull();
    expect(q('ptz-home-mark', row('pos_1'))).toBeNull();
  });

  it('down on the first row sends the full new order; up is off on the first row, down on the last', async () => {
    await render();
    expect((q('ptz-up', row('pos_1')) as HTMLButtonElement).disabled).toBe(true);
    expect((q('ptz-down', row('pos_3')) as HTMLButtonElement).disabled).toBe(true);
    await click(q('ptz-down', row('pos_1')));
    expect(writes()).toEqual([{ url: '/api/cameras/den/ptz/positions/order', method: 'PUT', body: { ids: ['pos_2', 'pos_1', 'pos_3'] } }]);
    expect(names()).toEqual(['Door', 'Gate', 'Drive']);
  });

  it('dropping one row on another sends the full new order', async () => {
    await render();
    const dt = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' };
    const drag = (el: Element, t: string) => {
      const e = new Event(t, { bubbles: true, cancelable: true });
      Object.assign(e, { dataTransfer: dt });
      el.dispatchEvent(e);
    };
    expect(q('ptz-grip', row('pos_3'))!.getAttribute('draggable')).toBe('true');
    drag(q('ptz-grip', row('pos_3'))!, 'dragstart');
    drag(row('pos_1'), 'dragover');
    drag(row('pos_1'), 'drop');
    await settle();
    expect(writes()).toEqual([{ url: '/api/cameras/den/ptz/positions/order', method: 'PUT', body: { ids: ['pos_3', 'pos_1', 'pos_2'] } }]);
  });

  it('a failed reorder shows the error and reloads the list', async () => {
    await render();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => (init.method === 'PUT' ? json(502, { error: 'camera_error' }) : backend(url, init))),
    );
    await click(q('ptz-down', row('pos_1')));
    expect(q('ptz-error')!.textContent).toBe("The camera didn't accept that. Try again.");
    expect(names()).toEqual(['Gate', 'Door', 'Drive']);
  });

  it('renames inline; Enter saves the trimmed name; a duplicate shows a message and sends nothing', async () => {
    await render();
    await click(q('ptz-rename', row('pos_2')));
    const input = q('ptz-rename-input', row('pos_2'))!;
    expect((input as HTMLInputElement).value).toBe('Door');
    type(input, ' gate ');
    key(input, 'Enter');
    await settle();
    expect(q('ptz-rename-error', row('pos_2'))!.textContent).toBe('Another position already has that name.');
    expect(writes()).toEqual([]);
    type(input, '  Front door ');
    key(input, 'Enter');
    await settle();
    expect(writes()).toEqual([{ url: '/api/cameras/den/ptz/positions/pos_2', method: 'PATCH', body: { name: 'Front door' } }]);
    expect(q('ptz-rename-input')).toBeNull();
    expect(names()).toEqual(['Gate', 'Front door', 'Drive']);
  });

  it('renaming to the same name, or Escape, closes the editor without a request', async () => {
    await render();
    await click(q('ptz-rename', row('pos_2')));
    key(q('ptz-rename-input')!, 'Enter');
    await settle();
    expect(q('ptz-rename-input')).toBeNull();
    await click(q('ptz-rename', row('pos_3')));
    type(q('ptz-rename-input')!, 'Something');
    key(q('ptz-rename-input')!, 'Escape');
    await settle();
    expect(q('ptz-rename-input')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('delete asks inline and deletes on confirm', async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    await render();
    await click(q('ptz-delete', row('pos_3')));
    expect(q('ptz-confirm')!.textContent).toContain('Delete “Drive”?');
    expect(writes()).toEqual([]);
    await click(q('ptz-confirm-delete'));
    expect(writes()).toEqual([{ url: '/api/cameras/den/ptz/positions/pos_3', method: 'DELETE', body: undefined }]);
    expect(names()).toEqual(['Gate', 'Door']);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('cancel on the confirm row keeps the position', async () => {
    await render();
    await click(q('ptz-delete', row('pos_2')));
    await click(q('ptz-confirm-cancel'));
    expect(q('ptz-confirm')).toBeNull();
    expect(names()).toEqual(['Gate', 'Door', 'Drive']);
    expect(writes()).toEqual([]);
  });

  it('deleting Home while others exist explains why and sends nothing', async () => {
    await render();
    await click(q('ptz-delete', row('pos_1')));
    expect(q('ptz-confirm')!.textContent).toContain("Home can't be deleted while other positions exist. Make another position Home first.");
    expect(q('ptz-confirm-delete')).toBeNull();
    await click(q('ptz-confirm-ok'));
    expect(q('ptz-confirm')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('save opens a field with the next free "Position N" and posts the name', async () => {
    list = [pos(1, 'Position 1'), pos(2, 'Position 2')];
    await render();
    await click(q('ptz-save'));
    const input = q('ptz-save-input') as HTMLInputElement;
    expect(input.value).toBe('Position 3');
    key(input, 'Enter');
    await settle();
    expect(writes()).toEqual([{ url: '/api/cameras/den/ptz/positions', method: 'POST', body: { name: 'Position 3' } }]);
    expect(q('ptz-save-input')).toBeNull();
    expect(names()).toEqual(['Position 1', 'Position 2', 'Position 3']);
  });

  it('save checks the name before asking', async () => {
    await render();
    await click(q('ptz-save'));
    type(q('ptz-save-input')!, 'door');
    key(q('ptz-save-input')!, 'Enter');
    await settle();
    expect(q('ptz-save-error')!.textContent).toBe('Another position already has that name.');
    expect(writes()).toEqual([]);
  });

  it("shows the proxy's name_taken as a message", async () => {
    await render();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => (init.method === 'POST' ? json(409, { error: 'name_taken' }) : backend(url, init))));
    await click(q('ptz-save'));
    type(q('ptz-save-input')!, 'Shed');
    key(q('ptz-save-input')!, 'Enter');
    await settle();
    expect(q('ptz-error')!.textContent).toBe('That name is already used.');
  });

  it('save is disabled at max with the note', async () => {
    max = 2;
    list = [pos(1, 'Gate'), pos(2, 'Door')];
    await render();
    expect((q('ptz-save') as HTMLButtonElement).disabled).toBe(true);
    expect(q('ptz-max-note')!.textContent).toBe('2 positions saved — the most a camera keeps. Delete one to save another.');
  });

  it('a missing row offers Save again and no go', async () => {
    list[0].state = 'missing';
    await render();
    expect(q('ptz-go', row('pos_1'))).toBeNull();
    expect(row('pos_1').textContent).toContain('Not on the camera — save again');
    await click(q('ptz-resave', row('pos_1')));
    expect(writes()).toEqual([{ url: '/api/cameras/den/ptz/positions/pos_1/save', method: 'POST', body: {} }]);
    expect(q('ptz-resave', row('pos_1'))).toBeNull();
    expect(q('ptz-go', row('pos_1'))).not.toBeNull();
  });

  it('reloads on ptz-positions for this camera while open, not for another, not while closed', async () => {
    await render();
    const gets = () => calls.filter((c) => c.method === 'GET').length;
    expect(gets()).toBe(1);
    list.push(pos(4, 'Shed', { order: 3, home: false }));
    for (const fn of ptzListeners) fn('barn');
    await vi.advanceTimersByTimeAsync(400);
    expect(gets()).toBe(1);
    for (const fn of ptzListeners) fn('den');
    for (const fn of ptzListeners) fn('den');
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    expect(gets()).toBe(2);
    expect(names()).toEqual(['Gate', 'Door', 'Drive', 'Shed']);
    await click(q('ptz-toggle'));
    for (const fn of ptzListeners) fn('den');
    await vi.advanceTimersByTimeAsync(400);
    expect(gets()).toBe(2);
  });

  it('keeps the rows on screen while reloading (no flicker)', async () => {
    await render();
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    for (const fn of ptzListeners) fn('den');
    await vi.advanceTimersByTimeAsync(400);
    flushSync();
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(names()).toEqual(['Gate', 'Door', 'Drive']);
    expect(q('ptz-loading')).toBeNull();
    release();
    await settle();
    expect(names()).toEqual(['Gate', 'Door', 'Drive']);
  });

  it('says "Loading positions…" only before the first answer', async () => {
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    await render();
    expect(q('ptz-loading')!.textContent).toBe('Loading positions…');
    release();
    await settle();
    expect(q('ptz-loading')).toBeNull();
  });

});
