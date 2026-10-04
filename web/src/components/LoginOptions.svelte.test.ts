// @vitest-environment jsdom
//
// The start page's sign-in variants (spec 2026-10-04-pi-deployment-design):
// Google only, token only, both (Google first, the token form behind a
// secondary button), and the token form's errors.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginOptions from './LoginOptions.svelte';
import type { LoginMethod } from '../lib/login';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;

afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
});

function render(methods: LoginMethod[], failed = false) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(LoginOptions, { target, props: { methods, failed } });
  flushSync();
  return target;
}
const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function submit(el: HTMLElement, token: string) {
  const input = q(el, 'token-input') as HTMLInputElement;
  input.value = token;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  (q(el, 'token-form') as HTMLFormElement).dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

describe('LoginOptions', () => {
  it('Google only: the Google button, no token form', () => {
    const el = render(['google']);
    expect(q(el, 'login')?.getAttribute('href')).toBe('/auth/google/login');
    expect(q(el, 'token-form')).toBeNull();
    expect(q(el, 'token-login-open')).toBeNull();
  });

  it('token only: the form at once, no Google button', () => {
    const el = render(['token']);
    expect(q(el, 'login')).toBeNull();
    expect(q(el, 'token-form')).not.toBeNull();
    const input = q(el, 'token-input') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(q(el, 'token-submit')?.textContent).toContain('Sign in with token');
  });

  it('both: Google first, the token form behind "Sign in with token"', () => {
    const el = render(['google', 'token']);
    const google = q(el, 'login')!;
    const open = q(el, 'token-login-open')!;
    expect(google.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(q(el, 'token-form')).toBeNull();
    open.click();
    flushSync();
    expect(q(el, 'token-form')).not.toBeNull();
    expect(q(el, 'token-login-open')).toBeNull();
  });

  it('posts the token as JSON (not in the URL) and goes where the server says', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ redirect: '/app/timeline' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...location, assign });
    const el = render(['token']);
    await submit(el, 'the-demo-token-0123456789');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/auth/token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'the-demo-token-0123456789' });
    expect(assign).toHaveBeenCalledWith('/app/timeline');
  });

  it('shows the error for a wrong token, and for too many attempts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_token"}', { status: 401 })));
    const el = render(['token']);
    await submit(el, 'wrong');
    expect(q(el, 'token-error')?.textContent).toBe('That token is not right.');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"too_many_attempts"}', { status: 429 })));
    await submit(el, 'wrong again');
    expect(q(el, 'token-error')?.textContent).toBe('Too many attempts. Try again later.');
  });

  it('shows the error after a failed form post (?login=failed)', () => {
    const el = render(['token'], true);
    expect(q(el, 'token-error')?.textContent).toBe('That token is not right.');
  });
});
