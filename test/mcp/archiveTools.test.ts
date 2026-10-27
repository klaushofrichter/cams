// list_archive and get_archive_clip (spec §3), on the fake cam-proxy's Archive.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setCameras } from '../../server/cameraRegistry';
import { resetMcpLimits } from '../../server/mcp/limits';
import { resetProxyClients } from '../../server/proxy/client';
import { stopProxyStreams } from '../../server/proxy/stream';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from '../proxy/fakeProxy';
import { freshTokens, issue, mcpClient, startApp, type Running } from './helpers';
import { testJpeg } from './media';

type Client = Awaited<ReturnType<typeof mcpClient>>;
let app: Running, proxy: FakeProxy, client: Client, kept: number;
beforeAll(async () => {
  proxy = await startFakeProxy();
  kept = proxy.archive.add('cam1', { name: 'front door', labels: ['Person'], thumb: testJpeg(640, 360) }).id;
  proxy.archive.add('cam1', { name: 'driveway', labels: ['Vehicle'] });
  app = await startApp();
});
afterAll(async () => {
  await app.close();
  await proxy.stop();
});
beforeEach(async () => {
  freshTokens();
  resetMcpLimits();
  resetProxyClients();
  process.env.MCP_ENABLED = 'true';
  setCameras([{ id: 'cam1', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: proxy.url, token: FAKE_TOKEN } }]);
  client = await mcpClient(app.url, issue().token);
});
afterEach(async () => {
  await client.close();
  stopProxyStreams();
  delete process.env.MCP_ENABLED;
  setCameras([]);
});

const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; structuredContent: Record<string, unknown>; content: { type: string }[] }>;

describe('list_archive', () => {
  it('lists every archived clip with a ref, filtered by labels', async () => {
    const all = await call('list_archive', {});
    const items = all.structuredContent.items as { ref: string; name: string; camera: string; labels: string[] }[];
    expect(items.map((i) => i.name).sort()).toEqual(['driveway', 'front door']);
    expect(items.find((i) => i.name === 'front door')).toMatchObject({ ref: `cam1:${kept}`, camera: 'cam1', labels: ['Person'] });
    const persons = await call('list_archive', { labels: ['Person'] });
    expect((persons.structuredContent.items as { name: string }[]).map((i) => i.name)).toEqual(['front door']);
    const one = await call('list_archive', { limit: 1 });
    expect(one.structuredContent.truncated).toBe(true);
  });
});

describe('get_archive_clip', () => {
  it('gives the item, a video link and the thumbnail', async () => {
    const r = await call('get_archive_clip', { ref: `cam1:${kept}` });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ item: { ref: `cam1:${kept}`, name: 'front door' } });
    const url = (r.structuredContent.video as { url: string }).url;
    expect((await fetch(url)).status).toBe(200);
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(1);
  });

  it('refuses a malformed ref and answers not_found for an unknown one', async () => {
    expect((await call('get_archive_clip', { ref: '../x' })).isError).toBe(true);
    expect((await call('get_archive_clip', { ref: 'cam1:999999' })).structuredContent.error).toBe('not_found');
    expect((await call('get_archive_clip', { ref: 'nope:1' })).structuredContent.error).toBe('not_found');
  });
});
