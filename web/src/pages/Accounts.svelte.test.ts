// @vitest-environment jsdom
//
// The account picker (migration P4, M §9.5, R4-13): the person's accounts
// with their roles, the remembered one first and preselected; choosing one
// signs in to it.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Accounts from './Accounts.svelte';

const ITEMS = [
  { id: 'acc_A', name: 'alpha', displayName: 'Alpha', role: 'admin', current: false, remembered: false },
  { id: 'acc_B', name: 'beta', displayName: 'Beta', role: 'viewer', current: false, remembered: true },
];
let posted: unknown[] = [];
let assigned: string[] = [];
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;

beforeEach(() => {
  posted = [];
  assigned = [];
  vi.stubGlobal('location', { ...window.location, pathname: '/app/accounts', search: '', hash: '', assign: (u: string) => assigned.push(u) });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/accounts') return new Response(JSON.stringify({ items: ITEMS }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    posted.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ redirect: '/app/video' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
});
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

describe('Accounts', () => {
  it('lists the accounts with display names and roles, the remembered one first and preselected; choosing posts and navigates', async () => {
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(Accounts, { target });
    await settle();
    const rows = [...target.querySelectorAll('[data-testid^="account-"]')].filter((e) => /^account-acc_/.test(e.getAttribute('data-testid')!));
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['account-acc_B', 'account-acc_A']);
    expect(rows[0].textContent).toContain('Beta');
    expect(rows[0].textContent).toContain('Viewer');
    expect(rows[1].textContent).toContain('Admin');
    expect((target.querySelector('[data-testid="account-acc_B"]') as HTMLElement).getAttribute('aria-current')).toBe('true');
    (target.querySelector('[data-testid="account-acc_A"]') as HTMLButtonElement).click();
    await settle();
    expect(posted).toEqual([{ accountId: 'acc_A' }]);
    expect(assigned).toEqual(['/app/video']);
  });
});
