// get_snapshot, list_events, get_event, search_recordings (spec §3) through
// the SDK's client, on cam-sim and the fake cam-proxy.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { setCameras } from '../../server/cameraRegistry';
import { resetMcpLimits } from '../../server/mcp/limits';
import { resetProxyClients } from '../../server/proxy/client';
import { stopProxyStreams } from '../../server/proxy/stream';
import { createSimCamera } from '../camera/sim';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from '../proxy/fakeProxy';
import { freshTokens, issue, mcpClient, startApp, type Running } from './helpers';
import { jpegSize, testJpeg } from './media';

type Client = Awaited<ReturnType<typeof mcpClient>>;
let app: Running, cam: Server, proxy: FakeProxy, client: Client;
const DAY = 86_400_000;

beforeAll(async () => {
  const sim = await createSimCamera({
    user: 'u',
    password: 'p',
    clips: [
      { daysAgo: 0, start: '000100', end: '000130', triggers: ['person'] },
      { daysAgo: 0, start: '000200', end: '000210', triggers: ['motion'] },
      { daysAgo: 2, start: '120000', end: '120020', triggers: ['vehicle'] },
      { daysAgo: 10, start: '120000', end: '120020', triggers: ['person'] },
    ],
  });
  cam = sim.app.listen(0);
  await new Promise((r) => cam.once('listening', r));
  proxy = await startFakeProxy();
  app = await startApp();
});
afterAll(async () => {
  await app.close();
  await proxy.stop();
  await new Promise((r) => cam.close(r));
});

const host = () => `127.0.0.1:${(cam.address() as AddressInfo).port}`;
beforeEach(async () => {
  freshTokens();
  resetMcpLimits();
  resetProxyClients();
  process.env.MCP_ENABLED = 'true';
  setCameras([
    { id: 'cam1', name: 'Den', host: host(), protocol: 'http', user: 'u', password: 'p' },
    { id: 'cam2', name: 'Porch', host: host(), protocol: 'http', user: 'u', password: 'p', proxy: { url: proxy.url, token: FAKE_TOKEN, camera: 'cam1' } },
  ]);
  client = await mcpClient(app.url, issue().token);
});
afterEach(async () => {
  await client.close();
  stopProxyStreams();
  delete process.env.MCP_ENABLED;
  setCameras([]);
});

const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; structuredContent: Record<string, unknown>; content: { type: string; data?: string; mimeType?: string }[] }>;
const images = (r: Awaited<ReturnType<typeof call>>) => r.content.filter((c) => c.type === 'image').map((c) => Buffer.from(c.data!, 'base64'));

describe('get_snapshot', () => {
  it("is the camera's picture, scaled, without a fresh proxy still", async () => {
    const r = await call('get_snapshot', { camera: 'cam1', maxWidth: 320 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ camera: 'cam1', source: 'camera', width: 320 });
    const [img] = images(r);
    expect(jpegSize(img).width).toBe(320);
  });

  it("is the proxy's newest still when it is at most 5 s old", async () => {
    const ts = Date.now() - 1000;
    proxy.stills.set('cam1', new Map([[ts, testJpeg(1280, 720)]]));
    const r = await call('get_snapshot', { camera: 'cam2' });
    expect(r.structuredContent).toMatchObject({ camera: 'cam2', source: 'proxy-still', takenAtMs: ts, width: 1024 });
    expect(images(r)).toHaveLength(1);
  });

  it('names an unknown camera', async () => {
    const r = await call('get_snapshot', { camera: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toBe('unknown_camera');
  });
});

describe('list_events', () => {
  it("lists a range's events with their kinds, filtered", async () => {
    const now = Date.now();
    const all = await call('list_events', { camera: 'cam1', from: now - 3 * DAY, to: now + DAY });
    const ids = (all.structuredContent.events as { kinds: string[] }[]).map((e) => e.kinds.join());
    expect(ids).toEqual(expect.arrayContaining(['person', 'motion', 'vehicle']));
    expect(ids).not.toContain('person,person');
    const persons = await call('list_events', { camera: 'cam1', from: new Date(now - 3 * DAY).toISOString(), to: new Date(now + DAY).toISOString(), kinds: ['person'] });
    expect((persons.structuredContent.events as { kinds: string[] }[]).every((e) => e.kinds.includes('person'))).toBe(true);
    expect((persons.structuredContent.events as unknown[]).length).toBe(1);
  });

  it('refuses a range over 7 days and a range backwards', async () => {
    const now = Date.now();
    expect((await call('list_events', { camera: 'cam1', from: now - 8 * DAY, to: now })).structuredContent.error).toBe('range_too_large');
    expect((await call('list_events', { camera: 'cam1', from: now, to: now - DAY })).structuredContent.error).toBe('invalid');
  });

  it('caps the list', async () => {
    const now = Date.now();
    const r = await call('list_events', { camera: 'cam1', from: now - 3 * DAY, to: now + DAY, limit: 1 });
    expect(r.structuredContent).toMatchObject({ truncated: true });
    expect((r.structuredContent.events as unknown[]).length).toBe(1);
  });
});

describe('get_event', () => {
  it("gives the event and its thumbnail", async () => {
    const now = Date.now();
    const list = await call('list_events', { camera: 'cam1', from: now - DAY * 3, to: now + DAY, kinds: ['person'] });
    const id = (list.structuredContent.events as { id: string }[])[0].id;
    const r = await call('get_event', { camera: 'cam1', eventId: id });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ event: { id, kinds: ['person'] }, stills: [] });
    expect(images(r)).toHaveLength(1);
    expect((r.structuredContent.video as { url: string }).url).toMatch(new RegExp(`^${app.url}/mcp/media/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$`));
    const none = await call('get_event', { camera: 'cam1', eventId: id, images: 0 });
    expect(images(none)).toHaveLength(0);
  }, 30_000);

  it('answers not_found for an unknown event', async () => {
    const r = await call('get_event', { camera: 'cam1', eventId: '20200101-000000-000010' });
    expect(r.structuredContent.error).toBe('not_found');
  });
});

describe('search_recordings', () => {
  it('finds events across cameras and days, newest first, by kind', async () => {
    const now = Date.now();
    const r = await call('search_recordings', { from: now - 20 * DAY, to: now + DAY, cameras: ['cam1'], kinds: ['person'] });
    const hits = r.structuredContent.hits as { camera: string; startMs: number; kinds: string[] }[];
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.camera === 'cam1' && h.kinds.includes('person'))).toBe(true);
    expect(hits[0].startMs).toBeGreaterThan(hits[1].startMs);
    expect(r.structuredContent.daysSearched).toBeLessThanOrEqual(3);
  });

  it('refuses more than 31 days and an unknown camera', async () => {
    const now = Date.now();
    expect((await call('search_recordings', { from: now - 40 * DAY, to: now })).structuredContent.error).toBe('range_too_large');
    expect((await call('search_recordings', { from: now - DAY, to: now, cameras: ['nope'] })).structuredContent.error).toBe('unknown_camera');
  });
});
