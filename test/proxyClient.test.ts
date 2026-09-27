import { afterEach, describe, expect, it } from 'vitest';
import net from 'net';
import { ProxyClient, ProxyError } from '../server/proxy/client';
import { FAKE_TOKEN, JPEG, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

let fake: FakeProxy | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as ProxyError;
  }
  throw new Error('expected an error');
};

describe('ProxyClient', () => {
  it('reads JSON with the bearer token', async () => {
    fake = await startFakeProxy();
    fake.stills.set('den', new Map([[1000, JPEG], [2000, JPEG]]));
    const c = new ProxyClient({ url: fake.url, token: FAKE_TOKEN });
    expect(await c.json<number[]>('/api/cameras/den/stills', { from: 0, to: 5000 })).toEqual([1000, 2000]);
    expect(fake.requests.at(-1)?.auth).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('opens a response for streaming, passing 404 through', async () => {
    fake = await startFakeProxy();
    fake.stills.set('den', new Map([[1000, JPEG]]));
    const c = new ProxyClient({ url: fake.url, token: FAKE_TOKEN });
    const ok = await c.open('/api/cameras/den/stills/1000.jpg');
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(JPEG);
    expect((await c.open('/api/cameras/den/stills/9.jpg')).status).toBe(404);
  });

  it('maps a refused token, a dead proxy and a timeout, never showing the token', async () => {
    fake = await startFakeProxy();
    const refused = await errorOf(new ProxyClient({ url: fake.url, token: 'wrong-'.padEnd(40, 'w') }).json('/api/cameras/den/stills', { from: 0, to: 1 }));
    expect(refused).toBeInstanceOf(ProxyError);
    expect(refused.code).toBe('proxy_unauthorized');
    fake.offline = true;
    const down = await errorOf(new ProxyClient({ url: fake.url, token: FAKE_TOKEN }).json('/api/cameras/den/stills', { from: 0, to: 1 }));
    expect(down.code).toBe('proxy_unreachable');
    // A server that accepts and never answers.
    const silent = net.createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(silent.address() as net.AddressInfo).port}`;
    const slow = await errorOf(new ProxyClient({ url, token: FAKE_TOKEN }, { timeoutMs: 200 }).json('/x'));
    expect(slow.code).toBe('proxy_unreachable');
    silent.close();
    for (const e of [refused, down, slow]) {
      expect(e.message).not.toContain(FAKE_TOKEN);
      expect(e.message).toContain('127.0.0.1'); // the host, for the log
    }
  });

  it('answers other failures as proxy_error with the status', async () => {
    fake = await startFakeProxy();
    const e = await errorOf(new ProxyClient({ url: fake.url, token: FAKE_TOKEN }).json('/api/cameras/den/stills', { from: 'x', to: 1 }));
    expect(e.code).toBe('proxy_error');
    expect(e.status).toBe(400);
  });
});
