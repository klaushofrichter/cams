// A fleet with cameras reached through their cam-proxy only (camera-calls):
// the fake proxy, and a cam-sim at the configured host with a valid
// password, so any direct call would succeed and shows in its counters.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { setCameras, type FileCameraConfig } from '../../server/cameraRegistry';
import { resetProxyClients } from '../../server/proxy/client';
import { resetProxyCameraCalls } from '../../server/proxy/cameraCalls';
import { CAMERA_CALLS, loadProxyFeatures, noteProxyFeatures } from '../../server/proxy/features';
import { resetClients } from '../../server/reolink/clients';
import { fileAccount } from '../../server/fleet';
import { FAKE_ADMIN_TOKEN, FAKE_TOKEN, startFakeProxy, type FakeProxy } from '../proxy/fakeProxy';
import { createSimCamera, type SimCameraOptions, type SimState } from '../camera/sim';

export interface ThroughProxy {
  fake: FakeProxy;
  sim: SimState;
  simHost: string;
  close(): Promise<void>;
}

// `cameras`: the cams camera ids and the proxy's id for each (default den → cam1).
export async function startThroughProxy(o: { adminToken?: boolean; cameras?: [string, string][]; sim?: Partial<SimCameraOptions>; extra?: FileCameraConfig[] } = {}): Promise<ThroughProxy> {
  process.env.PROXY_FEATURES_FILE = join(mkdtempSync(join(tmpdir(), 'cams-through-')), 'proxy-features.json');
  loadProxyFeatures();
  const c = await createSimCamera({ user: 'u', password: 'p', ...o.sim });
  const camServer: Server = c.app.listen(0);
  await new Promise((r) => camServer.once('listening', r));
  const simHost = `127.0.0.1:${(camServer.address() as AddressInfo).port}`;
  const fake = await startFakeProxy();
  fake.features = ['sse-cam-list', 'ptz', CAMERA_CALLS];
  const cams = o.cameras ?? [['den', 'cam1']];
  for (const [, remote] of cams) if (!fake.cameraNames.has(remote)) fake.cameraNames.set(remote, remote);
  setCameras([
    ...cams.map(([id, remote]): FileCameraConfig => ({ id, name: id, host: simHost, protocol: 'http', user: 'u', password: 'p', proxy: { url: fake.url, token: FAKE_TOKEN, camera: remote, ...(o.adminToken !== false && { adminToken: FAKE_ADMIN_TOKEN }) } })),
    ...(o.extra ?? []),
  ]);
  resetProxyClients();
  resetClients();
  resetProxyCameraCalls();
  await noteProxyFeatures(fileAccount().id, fake.url, [{ features: [CAMERA_CALLS] }]);
  return {
    fake,
    sim: c.state,
    simHost,
    async close() {
      await fake.stop();
      await new Promise<void>((r) => camServer.close(() => r()));
      setCameras([]);
      resetClients();
      delete process.env.PROXY_FEATURES_FILE;
      loadProxyFeatures();
    },
  };
}
