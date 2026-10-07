// The fleet and camera keys (migration P4, R4-8): every camera is
// <accountId>/<camsId>; file mode is one account and behaves as before.
import { afterEach, describe, expect, it } from 'vitest';
import { accountIdOf, camKey, camsIdOf, fileAccount, fileSafe, fleetAccount, fleetAccountByName, fleetAccounts, fleetEvents, parseKey, setFleet, type CamKey } from '../server/fleet';
import { accountCameras, cameraName, getCamera, listCameras, listProxied, resolveCamera, setCameras, setReportedName } from '../server/cameraRegistry';
import { proxyGroups } from '../server/proxy/groups';
import { proxyCameraId, proxyClientFor, resetProxyClients } from '../server/proxy/client';
import { ALPHA, BETA, k, twoAccounts } from './helpers/fleet';

afterEach(() => {
  setCameras([]);
  resetProxyClients();
});

describe('camera keys', () => {
  it('camKey / parseKey round-trip; bad parts throw; fileSafe has no slash', () => {
    const key = camKey('acc_0123456789ABCDEFGHJK', 'cam1');
    expect(parseKey(key)).toEqual({ accountId: 'acc_0123456789ABCDEFGHJK', camsId: 'cam1' });
    expect(camsIdOf(key)).toBe('cam1');
    expect(accountIdOf(key)).toBe('acc_0123456789ABCDEFGHJK');
    expect(fileSafe(key)).toBe('acc_0123456789ABCDEFGHJK.cam1');
    for (const [a, c] of [['acc_', 'cam1'], ['home', 'cam1'], ['acc_x', 'Cam1'], ['acc_x', 'a/b'], ['acc_x', ''], ['acc_x/y', 'cam1']]) expect(() => camKey(a, c)).toThrow();
    for (const bad of ['cam1', 'acc_x/', '/cam1', 'acc_x/cam1/x', 'acc_x/Cam1', 42]) expect(parseKey(bad as string)).toBeNull();
  });

  it('the file account is named home by default (CAMS_FILE_ACCOUNT) with a valid id', () => {
    expect(fileAccount().name).toBe(process.env.CAMS_FILE_ACCOUNT || 'home');
    expect(fileAccount().id).toMatch(/^acc_[A-Za-z0-9]{1,40}$/);
  });
});

describe('the fleet', () => {
  it('setCameras (file mode) puts every camera into the file account; a bare camsId finds nothing', () => {
    setCameras([{ id: 'cam1', name: 'Den', host: '192.0.2.5', protocol: 'https', user: 'cams', password: 'pw' }]);
    expect(getCamera('cam1' as CamKey)).toBeUndefined();
    expect(getCamera(k('cam1'))).toMatchObject({ camsId: 'cam1', accountId: fileAccount().id, credentials: 'ok' });
    expect(resolveCamera(fileAccount().id, 'cam1')).toBe(k('cam1'));
    expect(resolveCamera('acc_other', 'cam1')).toBeUndefined();
    expect(resolveCamera(fileAccount().id, '../cam1')).toBeUndefined();
    expect(resolveCamera(fileAccount().id, ['cam1'])).toBeUndefined();
    expect(listCameras(fileAccount().id).map((c) => c.id)).toEqual(['cam1']);
    expect(fleetAccounts().map((a) => a.name)).toEqual([fileAccount().name]);
  });

  it('two accounts with cam1 on different proxies: two groups, two clients, the proxy id is the camsId', () => {
    setFleet(twoAccounts());
    const groups = proxyGroups();
    expect(groups).toHaveLength(2);
    const [a, b] = groups;
    expect(a.key).not.toBe(b.key);
    expect(a.accountId).toBe(ALPHA);
    expect(b.accountId).toBe(BETA);
    expect(proxyClientFor(camKey(ALPHA, 'cam1'))).not.toBe(proxyClientFor(camKey(BETA, 'cam1')));
    expect(proxyCameraId(camKey(BETA, 'cam1'))).toBe('cam1');
    expect(accountCameras(ALPHA).map((c) => c.id)).toEqual([camKey(ALPHA, 'cam1')]);
    expect(listCameras(BETA)).toEqual([expect.objectContaining({ id: 'cam1', name: 'Beta cam' })]);
    expect(listProxied(ALPHA)).toEqual([camKey(ALPHA, 'cam1')]);
    expect(resolveCamera(BETA, 'cam1')).toBe(camKey(BETA, 'cam1'));
    expect(fleetAccount(BETA)?.name).toBe('beta');
    expect(fleetAccountByName('alpha')?.id).toBe(ALPHA);
  });

  it('the same proxy URL and token in two accounts are two groups (the key holds the account)', () => {
    setFleet(twoAccounts({ alphaUrl: 'http://127.0.0.1:1/same', betaUrl: 'http://127.0.0.1:1/same', alphaToken: 's'.repeat(40), betaToken: 's'.repeat(40) }));
    const groups = proxyGroups();
    expect(groups).toHaveLength(2);
    expect(groups[0].members).toEqual([camKey(ALPHA, 'cam1')]);
    expect(groups[1].members).toEqual([camKey(BETA, 'cam1')]);
    expect(proxyClientFor(camKey(ALPHA, 'cam1'))).not.toBe(proxyClientFor(camKey(BETA, 'cam1')));
  });

  it('reported names and addresses are per key', () => {
    setFleet(twoAccounts());
    setReportedName(camKey(ALPHA, 'cam1'), 'Yard');
    expect(cameraName(camKey(ALPHA, 'cam1'))).toBe('Yard');
    expect(cameraName(camKey(BETA, 'cam1'))).toBe('Beta cam');
  });

  it('setFleet emits applied with the account ids', () => {
    const seen: string[][] = [];
    const on = (e: { accountIds: string[] }) => seen.push(e.accountIds);
    fleetEvents.on('applied', on);
    setFleet(twoAccounts());
    fleetEvents.off('applied', on);
    expect(seen).toEqual([[ALPHA, BETA]]);
  });
});
