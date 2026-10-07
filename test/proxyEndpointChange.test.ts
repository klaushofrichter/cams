// A confirmed change of a proxy's pins or TLS name on the same URL and token
// (security re-review N1): the proxy works again at once, without a restart —
// the cached proxy client and the event stream are rebuilt with the new
// endpoint the token is bound to.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyed } from '../server/cameraRegistry';
import { camKey, setFleet, fleetEvents } from '../server/fleet';
import { onFleetApplied } from '../server/fleetApply';
import { proxyClientFor, resetProxyClients } from '../server/proxy/client';
import { proxyHub, proxyStates, stopProxyStreams } from '../server/proxy/stream';
import { bindSecret, clearSecretBindings, proxyEndpoint, setSecretGuard } from '../server/secretGuard';
import { ALPHA } from './helpers/fleet';
import { FAKE_TOKEN, startFakeProxy, type FakeProxy } from './proxy/fakeProxy';

let fake: FakeProxy;
const OPTS = { backoffMinMs: 50, backoffMaxMs: 300, healthyMs: 200 };
const applied = () => onFleetApplied(OPTS);
beforeEach(async () => {
  fake = await startFakeProxy();
});
afterEach(async () => {
  fleetEvents.off('applied', applied);
  stopProxyStreams();
  setSecretGuard(false);
  clearSecretBindings();
  resetProxyClients();
  setFleet([]);
  await fake.stop();
});

const fleetWith = (tlsServername: string) => {
  const cams = keyed(ALPHA, [{ id: 'cam1', name: 'Den', host: '127.0.0.1:9', protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN } }])
    .map((c) => ({ ...c, proxy: { ...c.proxy!, tlsServername } }));
  return [{ id: ALPHA, name: 'alpha', displayName: 'Alpha', users: [], cameras: cams }];
};
const bind = (tls: string) => {
  clearSecretBindings();
  bindSecret(FAKE_TOKEN, proxyEndpoint({ url: fake.url, pins: null, tlsServername: tls }));
};

describe('a confirmed proxy endpoint change', () => {
  it('the proxy and its live events work again without a restart', async () => {
    fleetEvents.on('applied', applied);
    setSecretGuard(true);
    bind('proxy-a.example');
    setFleet(fleetWith('proxy-a.example'));
    expect((await proxyClientFor(camKey(ALPHA, 'cam1'))!.open('/api/cameras')).status).toBe(200);
    await expect.poll(() => proxyStates(ALPHA)[0]?.up).toBe(true);
    const asks = () => fake.requests.filter((r) => r.path === '/api/stream').length;
    const before = asks();
    // the admin confirmed a new TLS name on the same URL and token
    bind('proxy-b.example');
    setFleet(fleetWith('proxy-b.example'));
    expect((await proxyClientFor(camKey(ALPHA, 'cam1'))!.open('/api/cameras')).status).toBe(200);
    await expect.poll(asks).toBeGreaterThan(before); // the stream reconnected with the new client
    await expect.poll(() => proxyStates(ALPHA)[0]?.up).toBe(true);
    // live events flow again
    const got: unknown[] = [];
    const on = (m: unknown) => got.push(m);
    proxyHub.on('message', on);
    fake.push({ cam: 'cam1', type: 'clip', data: { clipId: 7 } });
    await expect.poll(() => got.length).toBeGreaterThan(0);
    proxyHub.off('message', on);
  });
});
