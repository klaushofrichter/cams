import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getCamera, listCameras, loadCameras, setCameras } from '../server/cameraRegistry';

const dir = mkdtempSync(join(tmpdir(), 'cams-reg-'));
function file(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}
const cam1 = { id: 'cam1', name: 'Den', host: '10.0.0.5', user: 'cams', password: 'pw' };

afterEach(() => setCameras([]));

describe('loadCameras', () => {
  it('returns [] when no file is configured', () => {
    expect(loadCameras(undefined)).toEqual([]);
  });

  // Review focus 4: the Secret may not exist yet; the app must still start.
  it('returns [] for a configured but missing file', () => {
    expect(loadCameras(join(dir, 'does-not-exist.json'))).toEqual([]);
  });

  it('loads a valid list', () => {
    expect(loadCameras(file('ok.json', JSON.stringify([cam1])))).toEqual([cam1]);
  });

  it('fails on malformed JSON, naming the file', () => {
    const p = file('bad.json', '[{');
    expect(() => loadCameras(p)).toThrow(/bad\.json.*not valid JSON/);
  });

  it('fails on a non-array', () => {
    expect(() => loadCameras(file('obj.json', '{}'))).toThrow(/must be a JSON array/);
  });

  it('fails on a missing field, naming entry and field', () => {
    const { password: _omit, ...noPassword } = cam1;
    expect(() => loadCameras(file('nopw.json', JSON.stringify([noPassword])))).toThrow(/entry 0.*password/);
  });

  it('fails on an unsafe id', () => {
    expect(() => loadCameras(file('id.json', JSON.stringify([{ ...cam1, id: 'Cam 1' }])))).toThrow(/entry 0.*id/);
  });

  it('fails on duplicate ids', () => {
    expect(() => loadCameras(file('dup.json', JSON.stringify([cam1, { ...cam1, name: 'Other' }])))).toThrow(/duplicate id "cam1"/);
  });
});

describe('listCameras / getCamera', () => {
  it('exposes only id and name', () => {
    setCameras([cam1]);
    expect(listCameras()).toEqual([{ id: 'cam1', name: 'Den' }]);
    expect(getCamera('cam1')).toEqual(cam1);
    expect(getCamera('nope')).toBeUndefined();
  });
});
