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
import { ReolinkClient } from '../../server/reolink/client';
import { clipTimes, parseClipName } from '../../server/recordings/clipNames';
import type { FakeRecording } from '../proxy/fakeProxy';

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

// The SD recordings the fake lists for `date`: what cam-sim holds, read with
// a client of its own (not the fleet's: a through-proxy camera has none), so
// read the sim's counters after this.
export async function seedThroughRecordings(t: ThroughProxy, date: string, remote = 'cam1'): Promise<FakeRecording[]> {
  const c = new ReolinkClient({ id: 'seed', name: 'seed', host: t.simHost, protocol: 'http', user: 'u', password: 'p' });
  const time = await c.timeInfo();
  const list: FakeRecording[] = [];
  for (const stream of ['sub', 'main'] as const) {
    for (const f of await c.searchDay(date, stream)) {
      const p = parseClipName(f.name);
      if (!p) continue;
      const tt = clipTimes(p, time);
      const id = f.name.slice(f.name.lastIndexOf('/') + 1);
      list.push({ id, start: Date.parse(tt.start), end: Date.parse(tt.end), stream, body: Buffer.from(`sd ${stream} ${id} `.repeat(10)) });
    }
  }
  t.fake.recordings.set(remote, list);
  return list;
}
