// @vitest-environment jsdom
//
// The viewer token sign-in (cams-admin design 2026-11-05 §9.2): paste signs
// in; a link's fragment asks "Sign in as '<name>'?" first; a bad link says
// so; the scanner button only on a secure page, a scanned code from
// elsewhere is not taken, a camera refusal is said in words.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TokenSignIn from './TokenSignIn.svelte';

const T = 'cav_CompTestFakeTokenNo001';
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;

afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const q = (id: string) => target!.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function render(props: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(TokenSignIn, { target, props: { scanner: false, origin: 'https://cams.example.test', ...props } });
  flushSync();
}

function server(answers: Record<string, { status: number; body: unknown }>) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const a = answers[url];
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  }));
  const assign = vi.fn();
  vi.stubGlobal('location', { ...location, assign });
  return { calls, assign };
}

describe('paste', () => {
  it('signs in straight away with the trimmed token, in the body', async () => {
    const { calls, assign } = server({ '/auth/viewer-token': { status: 200, body: { redirect: '/app/video' } } });
    render();
    const input = q('vt-input') as HTMLInputElement;
    input.value = `  ${T}\n`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    q('vt-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(calls).toEqual([{ url: '/auth/viewer-token', body: { token: T } }]);
    expect(assign).toHaveBeenCalledWith('/app/video');
  });

  it('not a token: said, nothing sent; a refused one: the error', async () => {
    const { calls } = server({ '/auth/viewer-token': { status: 401, body: { error: 'invalid_token' } } });
    render();
    const input = q('vt-input') as HTMLInputElement;
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    q('vt-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(calls).toEqual([]);
    expect(q('vt-error')?.textContent).toContain('not a cams token');
    input.value = T;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    q('vt-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(q('vt-error')?.textContent).toContain('expired or been revoked');
  });
});

describe('the link (fragment)', () => {
  it('asks first: "Sign in as \'<name>\'?" with one button; signs in only on the click', async () => {
    const { calls, assign } = server({
      '/auth/viewer-token/check': { status: 200, body: { name: 'Kitchen tablet', expiresAt: Date.UTC(2026, 10, 12) } },
      '/auth/viewer-token': { status: 200, body: { redirect: '/app/video' } },
    });
    render({ fragment: `#t=${T}` });
    await settle();
    expect(calls.map((c) => c.url)).toEqual(['/auth/viewer-token/check']);
    expect(q('vt-confirm-text')?.textContent).toBe("Sign in as 'Kitchen tablet'?");
    expect(q('vt-confirm-valid')?.textContent).toMatch(/^Valid until /);
    expect(assign).not.toHaveBeenCalled();
    q('vt-signin')!.click();
    await settle();
    expect(calls.map((c) => c.url)).toEqual(['/auth/viewer-token/check', '/auth/viewer-token']);
    expect(calls[1].body).toEqual({ token: T });
    expect(assign).toHaveBeenCalledWith('/app/video');
  });

  it('a revoked or expired token: the error, no confirm; an incomplete link: said', async () => {
    server({ '/auth/viewer-token/check': { status: 401, body: { error: 'invalid_token' } } });
    render({ fragment: `#t=${T}` });
    await settle();
    expect(q('vt-confirm')).toBeNull();
    expect(q('vt-error')?.textContent).toContain('expired or been revoked');
    unmount(component!);
    target!.remove();
    render({ fragment: '#t=cav_short' });
    await settle();
    expect(q('vt-error')?.textContent).toContain('incomplete');
  });
});

describe('the scanner', () => {
  it('not on an insecure page: the paste field and a note only', () => {
    render({ scanner: false });
    expect(q('vt-scan')).toBeNull();
    expect(q('vt-no-scanner')).not.toBeNull();
  });

  it('a camera refusal is said in words, and the button comes back', async () => {
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); }) } });
    render({ scanner: true });
    q('vt-scan')!.click();
    await settle();
    expect(q('vt-error')?.textContent).toContain('camera could not be opened');
    expect(q('vt-scan')).not.toBeNull();
  });
});
