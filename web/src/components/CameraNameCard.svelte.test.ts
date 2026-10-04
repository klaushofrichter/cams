// @vitest-environment jsdom
//
// Settings → camera → Name (design reolink/camera-name-design.md): checked
// with the camera's rules as you type, saved through cams (which asks the
// camera's cam-proxy, or the camera), the name read back shown everywhere.
import { flushSync, mount, unmount } from 'svelte';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CameraNameCard from './CameraNameCard.svelte';
import { cameras } from '../lib/stores';

const calls: { url: string; body: unknown }[] = [];
let answer = { status: 200, body: {} as unknown };
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;

beforeEach(() => {
  calls.length = 0;
  answer = { status: 200, body: {} };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  });
  cameras.set([
    { id: 'den', name: 'Den', webUiUrl: null, proxy: true, proxyConfigured: true },
    { id: 'shed', name: 'Shed', webUiUrl: null },
  ]);
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
  cameras.set([]);
});

const props = $state({ cameraId: 'den' });
function render(cameraId: string) {
  props.cameraId = cameraId;
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(CameraNameCard, { target, props });
  flushSync();
  return target;
}
const q = <T extends Element = HTMLElement>(id: string) => target!.querySelector<T>(`[data-testid="${id}"]`);
const input = () => q<HTMLInputElement>('camera-name-input')!;
const save = () => q<HTMLButtonElement>('save-camera-name')!;
const error = () => q('camera-name-error')?.textContent ?? null;
const type = (v: string) => {
  input().value = v;
  input().dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

describe('CameraNameCard', () => {
  it("shows the camera's current name, Save off until it changes", () => {
    render('den');
    expect(input().value).toBe('Den');
    expect(save().disabled).toBe(true);
    expect(q('camera-name-count')!.textContent).toBe('3/31');
    type('Backyard Left');
    expect(save().disabled).toBe(false);
    expect(error()).toBeNull();
  });

  it.each([
    ['x'.repeat(32), 'Too long: at most 31 characters.'],
    ['Den_Left', 'Not allowed: _'],
    ['Den é', 'Not allowed: é'],
    [' Den', 'No space at the start or end.'],
    ['Den ', 'No space at the start or end.'],
    ['', 'Enter a name.'],
  ])('refuses %j as you type: %s', (value, message) => {
    render('den');
    type(value);
    expect(error()).toContain(message);
    expect(save().disabled).toBe(true);
    expect(input().getAttribute('aria-invalid')).toBe('true');
  });

  it('takes 31 characters', () => {
    render('den');
    type('x'.repeat(31));
    expect(error()).toBeNull();
    expect(q('camera-name-count')!.textContent).toBe('31/31');
    expect(save().disabled).toBe(false);
  });

  it('saves, then shows the name read back here and in the camera list', async () => {
    render('den');
    answer = { status: 200, body: { name: 'Backyard Left' } };
    type('Backyard Left');
    save().click();
    await settle();
    expect(calls).toEqual([{ url: '/api/cameras/den/name', body: { name: 'Backyard Left' } }]);
    expect(q('save-state')!.dataset.state).toBe('saved');
    expect(input().value).toBe('Backyard Left');
    expect(get(cameras)[0].name).toBe('Backyard Left');
    expect(save().disabled).toBe(true);
  });

  it('says so when the camera kept its old name (the read-back differs)', async () => {
    render('den');
    answer = { status: 200, body: { name: 'Den' } };
    type('Backyard Left');
    save().click();
    await settle();
    expect(q('save-state')!.dataset.state).toBe('error');
    expect(error()).toBe('The camera kept the name "Den".');
    expect(input().value).toBe('Den');
    expect(get(cameras)[0].name).toBe('Den');
  });

  it('shows a camera_error as the camera refusing the change', async () => {
    render('den');
    answer = { status: 502, body: { error: 'camera_error' } };
    type('Backyard Left');
    save().click();
    await settle();
    expect(error()).toBe('The camera refused the change.');
  });

  it('shows the reason of a refusal under the field and keeps the edit', async () => {
    render('den');
    answer = { status: 400, body: { error: 'invalid_name', reason: 'not allowed: =' } };
    type('A=B');
    save().click();
    await settle();
    expect(error()).toBe('not allowed: =');
    expect(input().value).toBe('A=B');
    expect(get(cameras)[0].name).toBe('Den');
    type('A=BC'); // editing again clears it
    expect(error()).toBeNull();
  });

  it('says the camera is offline on a 503', async () => {
    render('den');
    answer = { status: 503, body: { error: 'camera_offline' } };
    type('Backyard Left');
    save().click();
    await settle();
    expect(error()).toMatch(/Camera offline/);
  });

  it('follows a rename made elsewhere while not edited, and keeps an edit', () => {
    render('den');
    cameras.update((l) => l.map((c) => (c.id === 'den' ? { ...c, name: 'Porch Light' } : c)));
    flushSync();
    expect(input().value).toBe('Porch Light');
    type('Mine');
    cameras.update((l) => l.map((c) => (c.id === 'den' ? { ...c, name: 'Theirs' } : c)));
    flushSync();
    expect(input().value).toBe('Mine');
  });

  it('starts over on another camera', () => {
    render('den');
    type('Den_');
    props.cameraId = 'shed';
    flushSync();
    expect(input().value).toBe('Shed');
    expect(error()).toBeNull();
  });
});
