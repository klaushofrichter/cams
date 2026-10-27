import { expect, test } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_ENV } from './env';
import { signIn } from './session';

// Settings → Assistant access (MCP) and /mcp itself (spec
// 2026-10-27-mcp-server-design): a token made on the card, shown once with
// its `claude mcp add` line, revoked; and the SDK's own client against the
// server. Every token made here is revoked again (3 live per person).
test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

test('the Settings card makes a token, shows it once and revokes it', async ({ page }, info) => {
  await page.goto('/app/settings');
  const card = page.getByTestId('settings-card-mcp');
  await expect(card).toBeVisible();
  const name = `e2e ${info.project.name} ${Date.now()}`;
  await card.getByTestId('mcp-name').fill(name);
  await card.getByTestId('mcp-create').click();
  await expect(card.getByTestId('mcp-new-token')).toContainText('cmcp_');
  await expect(card.getByTestId('mcp-add-line')).toContainText('claude mcp add --transport http cams');
  await expect(card.getByTestId('mcp-add-line')).toContainText('/mcp --header "Authorization: Bearer cmcp_');
  await card.getByTestId('mcp-done').click();
  await expect(card.getByTestId('mcp-new-token')).toHaveCount(0);
  const row = card.getByTestId('mcp-token-row').filter({ hasText: name }).first();
  await expect(row).toContainText('Expires in');
  await row.getByTestId('mcp-revoke').click();
  await row.getByTestId('mcp-revoke-confirm').click();
  await expect(card.getByTestId('mcp-token-row').filter({ hasText: name }).first()).toContainText('Revoked');
});

test('the SDK client lists the tools and reads cameras and a snapshot', async ({ request, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop', 'one size is enough for the protocol');
  const email = E2E_ENV.ALLOWED_EMAILS.split(',')[0].trim();
  const cookie = `session=${jwt.sign({ email }, E2E_ENV.COOKIE_SECRET, { expiresIn: '10m' })}`;
  const made = await request.post('/api/mcp-tokens', { headers: { cookie }, data: { name: `e2e sdk ${Date.now()}`, days: 1 } });
  expect(made.status()).toBe(201);
  const { token, item } = (await made.json()) as { token: string; item: { id: string } };
  const client = new Client({ name: 'cams-e2e', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_cameras', 'get_snapshot', 'list_events', 'generate_clip']));
    const cams = (await client.callTool({ name: 'list_cameras', arguments: {} })).structuredContent as { cameras: { id: string; name: string }[] };
    expect(cams.cameras.map((c) => c.name)).toContain('Den');
    const den = cams.cameras.find((c) => c.name === 'Den')!;
    const snap = await client.callTool({ name: 'get_snapshot', arguments: { camera: den.id, maxWidth: 640 } });
    expect(snap.isError).toBeFalsy();
    const content = snap.content as { type: string; mimeType?: string }[];
    expect(content.filter((c) => c.type === 'image').map((c) => c.mimeType)).toEqual(['image/jpeg']);
  } finally {
    await client.close();
    await request.post(`/api/mcp-tokens/${item.id}/revoke`, { headers: { cookie } });
  }
});
