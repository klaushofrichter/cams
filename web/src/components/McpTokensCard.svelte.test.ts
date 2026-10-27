// @vitest-environment jsdom
//
// Settings → Assistant access (MCP) (spec 2026-10-27-mcp-server-design §6):
// your own tokens; admins also every token of the account; a new token shown
// once with its `claude mcp add` line; a warning on a plain http viewer.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import McpTokensCard from './McpTokensCard.svelte';

const NOW = Date.now();
const mine = { id: 'mtk_AAAAAAAAAAAAAAAAAAAA', name: 'laptop', issuer: 'me@example.org', accountId: 'acc_x', scopes: ['read'], createdAt: NOW - 1000, expiresAt: NOW + 10 * 86_400_000, revokedAt: null, revokedBy: null, lastUsedAt: null, callsToday: 0, state: 'active' };
const theirs = { ...mine, id: 'mtk_BBBBBBBBBBBBBBBBBBBB', name: 'their pc', issuer: 'you@example.org' };
let plainHttp = false;
const calls: { url: string; method: string; body: unknown }[] = [];
let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;

beforeEach(() => {
  calls.length = 0;
  plainHttp = false;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (method === 'GET' && url === '/api/mcp-tokens') return json(200, { items: [mine], enabled: true, plainHttp, endpoint: 'http://cams.test/mcp' });
    if (method === 'GET' && url === '/api/mcp-tokens?all=1') return json(200, { items: [mine, theirs], enabled: true, plainHttp, endpoint: 'http://cams.test/mcp' });
    if (method === 'POST' && url === '/api/mcp-tokens') return json(201, { token: 'cmcp_secretsecret', item: { ...mine, id: 'mtk_CCCCCCCCCCCCCCCCCCCC', name: 'new' }, endpoint: 'http://cams.test/mcp' });
    if (method === 'POST' && url.endsWith('/revoke')) return json(200, { item: { ...mine, state: 'revoked' } });
    return json(404, { error: 'not_found' });
  });
});
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  vi.unstubAllGlobals();
});

async function render(admin: boolean) {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(McpTokensCard, { target, props: { admin } });
  await settle();
  return target;
}
const q = <T extends Element = HTMLElement>(id: string) => target!.querySelector<T>(`[data-testid="${id}"]`);
const qa = (id: string) => [...target!.querySelectorAll(`[data-testid="${id}"]`)];
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

describe('McpTokensCard', () => {
  it('lists your own tokens; no account section for a viewer', async () => {
    await render(false);
    expect(qa('mcp-token-row').map((r) => r.textContent)).toEqual([expect.stringContaining('laptop')]);
    expect(q('mcp-all-tokens')).toBeNull();
    expect(q('mcp-plain-http')).toBeNull();
    expect(calls.some((c) => c.url.includes('all=1'))).toBe(false);
  });

  it('shows an admin every token of the account with its issuer', async () => {
    await render(true);
    const all = q('mcp-all-tokens')!;
    expect(all.textContent).toContain('you@example.org');
    expect(all.textContent).toContain('their pc');
  });

  it('shows a new token once with its claude mcp add line', async () => {
    await render(false);
    const name = q<HTMLInputElement>('mcp-name')!;
    name.value = 'new';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    q<HTMLButtonElement>('mcp-create')!.click();
    await settle();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'new', days: 30 });
    expect(q('mcp-new-token')!.textContent).toContain('cmcp_secretsecret');
    expect(q('mcp-add-line')!.textContent).toBe('claude mcp add --transport http cams http://cams.test/mcp --header "Authorization: Bearer cmcp_secretsecret"');
    q<HTMLButtonElement>('mcp-done')!.click();
    flushSync();
    expect(target!.textContent).not.toContain('cmcp_secretsecret');
  });

  it('revokes after a confirmation', async () => {
    await render(false);
    q<HTMLButtonElement>('mcp-revoke')!.click();
    flushSync();
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(false);
    q<HTMLButtonElement>('mcp-revoke-confirm')!.click();
    await settle();
    expect(calls.find((c) => c.url.endsWith('/revoke'))?.url).toBe(`/api/mcp-tokens/${mine.id}/revoke`);
  });

  it('warns on a plain http viewer', async () => {
    plainHttp = true;
    await render(false);
    expect(q('mcp-plain-http')!.textContent).toMatch(/unencrypted/);
  });
});
