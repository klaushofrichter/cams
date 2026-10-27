// generate_clip, get_clip_job and analytics_usage (spec §3, §11.4), on the
// fake cam-proxy's compositions and budget; and the full tool list.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setCameras } from '../../server/cameraRegistry';
import { resetMcpJobs } from '../../server/mcp/jobs';
import { resetMcpLimits } from '../../server/mcp/limits';
import { resetProxyClients } from '../../server/proxy/client';
import { stopProxyStreams } from '../../server/proxy/stream';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from '../proxy/fakeProxy';
import { freshTokens, issue, mcpClient, startApp, type Running } from './helpers';

type Client = Awaited<ReturnType<typeof mcpClient>>;
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
let app: Running, proxy: FakeProxy, client: Client;
beforeAll(async () => {
  proxy = await startFakeProxy();
  app = await startApp();
});
afterAll(async () => {
  await app.close();
  await proxy.stop();
});
beforeEach(async () => {
  freshTokens();
  resetMcpLimits();
  resetMcpJobs();
  resetProxyClients();
  process.env.MCP_ENABLED = 'true';
  process.env.MCP_JOB_POLL_MS = '50';
  process.env.MCP_JOB_WAIT_MS = '3000';
  proxy.composeDelayMs = 200;
  proxy.compositions.clear();
  proxy.composeRequests.length = 0;
  const now = Math.floor(Date.now() / 1000) * 1000;
  proxy.stills.set('cam1', new Map(Array.from({ length: 120 }, (_, i) => [now - (i + 2) * 1000, Buffer.from('jpeg')])));
  setCameras([
    { id: 'cam1', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: proxy.url, token: FAKE_TOKEN } },
    { id: 'cam2', name: 'Porch', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p' },
  ]);
  client = await mcpClient(app.url, issue().token);
});
afterEach(async () => {
  await client.close();
  resetMcpJobs();
  stopProxyStreams();
  for (const k of ['MCP_ENABLED', 'MCP_JOB_POLL_MS', 'MCP_JOB_WAIT_MS', 'RATE_LIMIT_MCP_CLIPS_PER_HOUR']) delete process.env[k];
  setCameras([]);
});

const call = (name: string, args: Record<string, unknown>, c: Client = client) => c.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; structuredContent: Record<string, unknown> }>;
const window = () => {
  const end = Math.floor(Date.now() / 1000) * 1000 - 5000;
  return { start: end - 30_000, end };
};

describe('generate_clip', () => {
  it('composes a time range around its start and returns a link when done', async () => {
    const { start, end } = window();
    const r = await call('generate_clip', { camera: 'cam1', start: new Date(start).toISOString(), end });
    expect(r.isError).toBeFalsy();
    expect(proxy.composeRequests[0]).toMatchObject({ at: start, preS: 0, postS: 29, size: 'sd', badge: true });
    expect(r.structuredContent).toMatchObject({ state: 'done', video: { url: expect.stringMatching(/\/mcp\/media\//) } });
    const video = await fetch((r.structuredContent.video as { url: string }).url);
    expect(video.status).toBe(200);
    expect(video.headers.get('content-type')).toBe('video/mp4');
  });

  it('answers busy while the account has a job running, and get_clip_job follows it', async () => {
    proxy.composeDelayMs = 2000;
    process.env.MCP_JOB_WAIT_MS = '100';
    const { start, end } = window();
    const first = await call('generate_clip', { camera: 'cam1', start, end });
    expect(first.structuredContent.state).toBe('running');
    const second = await call('generate_clip', { camera: 'cam1', start, end });
    expect(second.structuredContent.error).toBe('busy');
    const job = first.structuredContent.job as string;
    // cams keeps the job alive by itself while nobody asks (the proxy stops one unpolled for 30 s).
    await waitFor(() => proxy.requests.filter((q) => q.path.endsWith(`/compositions/${job}`)).length >= 3);
    await waitFor(async () => (await call('get_clip_job', { job })).structuredContent.state === 'done', 5000);
    expect(((await call('get_clip_job', { job })).structuredContent.video as { url: string }).url).toMatch(/\/mcp\/media\//);
  });

  it('allows 10 clips an hour per account', async () => {
    process.env.RATE_LIMIT_MCP_CLIPS_PER_HOUR = '1';
    const { start, end } = window();
    expect((await call('generate_clip', { camera: 'cam1', start, end })).structuredContent.state).toBe('done');
    expect((await call('generate_clip', { camera: 'cam1', start, end })).structuredContent.error).toBe('rate_limited');
  });

  it('refuses a clip over the length rule, backwards times, and a camera without a proxy', async () => {
    const { end } = window();
    expect((await call('generate_clip', { camera: 'cam1', start: end - 400_000, end })).structuredContent.error).toBe('too_long');
    expect((await call('generate_clip', { camera: 'cam1', start: end, end: end - 1000 })).structuredContent.error).toBe('invalid');
    expect((await call('generate_clip', { camera: 'cam2', start: end - 10_000, end })).structuredContent.error).toBe('no_proxy');
  });

  it("get_clip_job knows only this token's jobs", async () => {
    const { start, end } = window();
    const r = await call('generate_clip', { camera: 'cam1', start, end });
    const other = await mcpClient(app.url, issue(undefined, 'klaus@klaushofrichter.net', 'other').token);
    try {
      expect((await call('get_clip_job', { job: r.structuredContent.job }, other)).structuredContent.error).toBe('not_found');
    } finally {
      await other.close();
    }
  });
});

describe('analytics_usage', () => {
  it("is each proxy camera's Vision budget", async () => {
    const r = await call('analytics_usage', {});
    expect(r.structuredContent).toEqual({ usage: [{ camera: 'cam1', enabled: true, paused: null, month: { calls: 14, limit: 1000 }, today: { calls: 2, cap: 30 }, checks: { today: 0, cap: 10 } }] });
    expect((await call('analytics_usage', { camera: 'cam2' })).structuredContent).toEqual({ usage: [{ camera: 'cam2', error: 'no_proxy' }] });
  });
});

describe('the tool list', () => {
  it('is exactly the ten read tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['analytics_usage', 'generate_clip', 'get_archive_clip', 'get_clip_job', 'get_event', 'get_snapshot', 'list_archive', 'list_cameras', 'list_events', 'search_recordings']);
  });
});

describe('generate_clip under pressure', () => {
  it('lets only one of two parallel calls start a clip', async () => {
    proxy.composeDelayMs = 2000;
    process.env.MCP_JOB_WAIT_MS = '100';
    const { start, end } = window();
    const [a, b] = await Promise.all([call('generate_clip', { camera: 'cam1', start, end }), call('generate_clip', { camera: 'cam1', start, end })]);
    expect([a.structuredContent.error, b.structuredContent.error].filter((e) => e === 'busy')).toHaveLength(1);
    expect(proxy.composeRequests).toHaveLength(1);
  });

  it('frees the account once the token that started the clip is revoked', async () => {
    proxy.composeDelayMs = 60_000;
    process.env.MCP_JOB_WAIT_MS = '100';
    const { start, end } = window();
    const { getMcpTokens } = await import('../../server/mcp/tokens.js');
    const { fileAccount } = await import('../../server/fleet.js');
    const { activeJob } = await import('../../server/mcp/jobs.js');
    const first = await mcpClient(app.url, issue(undefined, 'klaus@klaushofrichter.net', 'short-lived').token);
    try {
      expect((await call('generate_clip', { camera: 'cam1', start, end }, first)).structuredContent.state).toBe('running');
    } finally {
      await first.close();
    }
    const id = getMcpTokens().list(fileAccount().id).find((t) => t.name === 'short-lived')!.id;
    getMcpTokens().revoke(fileAccount().id, id, 'x');
    await waitFor(() => activeJob(fileAccount().id) === undefined, 3000);
    expect((await call('generate_clip', { camera: 'cam1', start, end })).structuredContent.error).not.toBe('busy');
  });
});
