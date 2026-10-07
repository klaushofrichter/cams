// The shadow comparison (migration P4, M §9.4, §11.3): the file's cameras
// against cams-admin's for the file account — camsIds and field names only,
// never a value, never a token or a password.
import { describe, expect, it } from 'vitest';
import vectors from '../../contract/cams-v1/vectors.json';
import { accountParts, verifySnapshot, type AccountPart } from '../../server/admin/snapshot';
import { shadowDiff } from '../../server/admin/shadow';
import type { FileCameraConfig } from '../../server/cameraRegistry';
import { signSnapshot } from './fakeAdmin';
import { INSTANCE, PRX_A, snapCamera, twoAccountsSnapshot } from './snapshots';

const partOf = (cams: Record<string, unknown>[], proxyExtra: Record<string, unknown> = {}, url = 'http://127.0.0.1:8480'): AccountPart => {
  const v = verifySnapshot(signSnapshot(twoAccountsSnapshot({ homeName: 'home', alphaCameras: cams, alphaUrl: url, alphaProxyExtra: proxyExtra })), [vectors.keys.server.publicKey], INSTANCE);
  if (!v.ok) throw new Error(v.reason);
  return accountParts(v.snapshot).ok.find((p) => p.account.name === 'home')!;
};
const FILE: FileCameraConfig = { id: 'cam1', name: 'Den', host: '192.0.2.5', protocol: 'https', tlsServername: 'cam1.example.net', user: 'cams', password: 'pw', proxy: { url: 'http://127.0.0.1:8480/', token: 'T'.repeat(40) } };
const SNAP = snapCamera({ camsId: 'cam1', name: 'Den', host: '192.0.2.5', protocol: 'https', tlsServername: 'cam1.example.net', cameraUser: 'cams', proxyId: PRX_A, proxyCameraId: 'cam1' });

describe('shadowDiff', () => {
  it('equal → []; trailing-slash URLs equal; the proxy camera id defaults to the camsId on both sides', () => {
    expect(shadowDiff([FILE], partOf([SNAP]))).toEqual([]);
    expect(shadowDiff([FILE], partOf([{ ...SNAP, proxyCameraId: null }]))).toEqual([]);
  });

  it('each field once', () => {
    const cases: [Partial<FileCameraConfig>, Record<string, unknown>, string][] = [
      [{}, { name: 'Other' }, 'cam1: name'],
      [{}, { host: '192.0.2.6' }, 'cam1: host'],
      [{ tlsServername: undefined }, { protocol: 'http', tlsServername: null }, 'cam1: protocol'],
      [{}, { tlsServername: 'x.example.net' }, 'cam1: tlsServername'],
      [{}, { webUiUrl: 'https://x.example/' }, 'cam1: webUiUrl'],
      [{}, { webUiNote: 'note' }, 'cam1: webUiNote'],
      [{}, { cameraUser: 'admin' }, 'cam1: user'],
      [{}, { proxyCameraId: 'cam7' }, 'cam1: proxy.camera'],
    ];
    for (const [f, s, want] of cases) expect(shadowDiff([{ ...FILE, ...f }], partOf([{ ...SNAP, ...s }]))).toEqual([want]);
    expect(shadowDiff([FILE], partOf([SNAP], {}, 'http://127.0.0.1:8481'))).toEqual(['cam1: proxy.url']);
    expect(shadowDiff([{ ...FILE, proxy: { ...FILE.proxy!, url: 'https://p.example:8443', tlsServername: 'p.example' } }], partOf([SNAP], {}, 'https://p.example:8443'))).toEqual(['cam1: proxy.tlsServername']);
  });

  it('pins in another case/format are equal; different pins are one item', () => {
    const hex = 'ab'.repeat(32);
    const file = { ...FILE, proxy: { ...FILE.proxy!, caFingerprint: [hex] } };
    expect(shadowDiff([file], partOf([SNAP], { caFingerprints: [`SHA256:${hex.toUpperCase()}`] }))).toEqual([]);
    expect(shadowDiff([file], partOf([SNAP], { caFingerprints: [`SHA256:${'CD'.repeat(32)}`] }))).toEqual(['cam1: proxy.caFingerprint']);
  });

  it('extra and missing cameras', () => {
    expect(shadowDiff([FILE, { ...FILE, id: 'cam2' }], partOf([SNAP, { ...SNAP, id: 'cam_X', camsId: 'cam3' }]))).toEqual(['cam2: only in the file', 'cam3: only in cams-admin']);
    expect(shadowDiff([FILE], undefined)).toEqual(['cam1: only in the file']);
  });

  it('no item contains a value (marker values in every field)', () => {
    const M = 'marker';
    const file: FileCameraConfig = { id: 'cam1', name: `${M}n`, host: `${M}h`, protocol: 'https', tlsServername: `${M}t`, user: `${M}u`, password: `${M}p`, webUiUrl: `https://${M}w/`, webUiNote: `${M}o`, proxy: { url: `https://${M}x:1`, token: `${M}`.padEnd(40, 'k'), camera: 'cam9', tlsServername: `${M}s` } };
    const items = shadowDiff([file], partOf([SNAP], {}, 'https://p.example:8443'));
    expect(items.length).toBeGreaterThan(5);
    for (const i of items) expect(i).not.toContain(M);
  });
});
