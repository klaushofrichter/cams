// No data crosses accounts over MCP (spec §7): ALPHA and BETA both have
// "cam1" on their own fake proxies; a token of ALPHA reaches only ALPHA's.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setCameras } from '../../server/cameraRegistry';
import { signLink } from '../../server/mcp/links';
import { resetMcpLimits } from '../../server/mcp/limits';
import { resetProxyClients } from '../../server/proxy/client';
import { stopProxyStreams } from '../../server/proxy/stream';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from '../proxy/fakeProxy';
import { ALPHA, BETA, applyFleet, restoreMode, twoAccounts } from '../helpers/fleet';
import { freshTokens, issue, mcpClient, startApp, type Running } from './helpers';
import { testJpeg } from './media';

let app: Running, A: FakeProxy, B: FakeProxy, betaItem: number;
beforeAll(async () => {
  [A, B] = await Promise.all([startFakeProxy(), startFakeProxy()]);
  A.archive.add('cam1', { name: 'alpha item' });
  betaItem = B.archive.add('cam1', { name: 'beta item' }).id;
  app = await startApp();
});
afterAll(async () => {
  await app.close();
  await Promise.all([A.stop(), B.stop()]);
});
beforeEach(() => {
  freshTokens();
  resetMcpLimits();
  resetProxyClients();
  process.env.MCP_ENABLED = 'true';
  applyFleet(twoAccounts({ alphaUrl: A.url, betaUrl: B.url, alphaToken: FAKE_TOKEN, betaToken: FAKE_TOKEN }));
  const now = Date.now() - 500;
  A.stills.set('cam1', new Map([[now, testJpeg(640, 360)]]));
  B.stills.set('cam1', new Map([[now, testJpeg(800, 450)]]));
});
afterEach(() => {
  stopProxyStreams();
  restoreMode();
  setCameras([]);
  delete process.env.MCP_ENABLED;
});

describe('MCP account isolation', () => {
  it("an ALPHA token sees only ALPHA's cameras, stills and archive", async () => {
    const { token } = issue(ALPHA, 'both@example.org');
    const c = await mcpClient(app.url, token);
    try {
      const cams = (await c.callTool({ name: 'list_cameras', arguments: {} })).structuredContent as { cameras: { id: string; hasProxy: boolean }[] };
      expect(cams.cameras.map((x) => x.id)).toEqual(['cam1']);
      const snap = (await c.callTool({ name: 'get_snapshot', arguments: { camera: 'cam1', maxWidth: 1568 } })).structuredContent as { width: number; source: string };
      expect(snap).toMatchObject({ source: 'proxy-still', width: 640 });
      const arch = (await c.callTool({ name: 'list_archive', arguments: {} })).structuredContent as { items: { name: string }[] };
      expect(arch.items.map((i) => i.name)).toEqual(['alpha item']);
      expect(B.requests.some((r) => r.path.includes('/stills') || r.path.includes('/archive'))).toBe(false);
    } finally {
      await c.close();
    }
  });

  it("a BETA token is BETA's, though the same person issued both", async () => {
    const { token } = issue(BETA, 'both@example.org');
    const c = await mcpClient(app.url, token);
    try {
      const snap = (await c.callTool({ name: 'get_snapshot', arguments: { camera: 'cam1', maxWidth: 1568 } })).structuredContent as { width: number };
      expect(snap.width).toBe(800);
    } finally {
      await c.close();
    }
  });

  it("a link naming BETA's item for an ALPHA token is refused", async () => {
    const { id } = issue(ALPHA, 'both@example.org');
    const forged = signLink({ tok: id, acc: BETA, cam: 'cam1', kind: 'archive', ref: String(betaItem), exp: Date.now() + 60_000 });
    expect((await fetch(`${app.url}/mcp/media/${forged}`)).status).toBe(403);
    // Signed for ALPHA, the same ref is looked up in ALPHA's archive only.
    const own = signLink({ tok: id, acc: ALPHA, cam: 'cam1', kind: 'archive', ref: String(betaItem + 1000), exp: Date.now() + 60_000 });
    expect((await fetch(`${app.url}/mcp/media/${own}`)).status).toBe(404);
  });
});
