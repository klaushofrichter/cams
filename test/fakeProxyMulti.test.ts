// test/fakeProxyMulti.test.ts
// The fake cam-proxy as a multi-camera host (cam-proxy spec 2026-10-05
// §6.2): one stream, `?cam=a,b` filters to those cameras.
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

let fake: FakeProxy | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

// Reads `count` data frames' `cam` from an SSE response.
async function cams(res: Response, count: number): Promise<string[]> {
  const out: string[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    for (const m of buf.matchAll(/^data: (.*)$/gm)) out.push(JSON.parse(m[1]).cam);
    buf = buf.slice(buf.lastIndexOf('\n') + 1);
    if (out.length >= count) break;
  }
  return out;
}

describe('fake proxy with several cameras', () => {
  it('lists every camera', async () => {
    fake = await startFakeProxy();
    fake.cameraNames.set('cam3', 'Gate');
    const list = (await (await fetch(`${fake.url}/api/cameras`, { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } })).json()) as { id: string }[];
    expect(list.map((c) => c.id)).toEqual(['cam1', 'cam3']);
  });

  it('filters the stream to the cameras in ?cam=, replay and live', async () => {
    fake = await startFakeProxy();
    fake.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    fake.push({ cam: 'cam2', type: 'clip', data: { clipId: 2 } });
    fake.push({ cam: 'cam3', type: 'clip', data: { clipId: 3 } });
    const ctl = new AbortController();
    const res = await fetch(`${fake.url}/api/stream?since=0&cam=cam1,cam3`, { headers: { Authorization: `Bearer ${FAKE_TOKEN}` }, signal: ctl.signal });
    const got = cams(res, 3);
    setTimeout(() => {
      fake!.push({ cam: 'cam2', type: 'clip', data: { clipId: 4 } });
      fake!.push({ cam: 'cam3', type: 'clip', data: { clipId: 5 } });
    }, 50);
    expect(await got).toEqual(['cam1', 'cam3', 'cam3']);
    ctl.abort();
  });

  it('as an old proxy (features null) reads ?cam=a,b as one id and lists no features', async () => {
    fake = await startFakeProxy();
    fake.features = null;
    const list = (await (await fetch(`${fake.url}/api/cameras`, { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } })).json()) as { features?: unknown }[];
    expect(list[0].features).toBeUndefined();
    fake.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    fake.push({ cam: 'cam1,cam2', type: 'clip', data: { clipId: 2 } }); // the only cam an old proxy would match
    const ctl = new AbortController();
    const res = await fetch(`${fake.url}/api/stream?since=0&cam=cam1,cam2`, { headers: { Authorization: `Bearer ${FAKE_TOKEN}` }, signal: ctl.signal });
    expect(await cams(res, 1)).toEqual(['cam1,cam2']);
    ctl.abort();
  });

  it('still takes a single ?cam=', async () => {
    fake = await startFakeProxy();
    fake.push({ cam: 'cam1', type: 'clip', data: { clipId: 1 } });
    fake.push({ cam: 'cam2', type: 'clip', data: { clipId: 2 } });
    const ctl = new AbortController();
    const res = await fetch(`${fake.url}/api/stream?since=0&cam=cam2`, { headers: { Authorization: `Bearer ${FAKE_TOKEN}` }, signal: ctl.signal });
    expect(await cams(res, 1)).toEqual(['cam2']);
    ctl.abort();
  });
});
