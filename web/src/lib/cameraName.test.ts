// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { cameraNameProblem, CAMERA_NAME_MAX, renameCamera } from './cameraName';
import { cameras } from './stores';

afterEach(() => {
  vi.unstubAllGlobals();
  cameras.set([]);
});

function answer(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}

describe('the Name field (the server’s rules, one module)', () => {
  it('uses the same rules as the server', () => {
    expect(CAMERA_NAME_MAX).toBe(31);
    expect(cameraNameProblem('x'.repeat(31))).toBeNull();
    expect(cameraNameProblem('x'.repeat(32))).toMatch(/Too long/);
    expect(cameraNameProblem('Den_1')).toMatch(/Not allowed: _/);
    expect(cameraNameProblem('Den ')).toMatch(/No space/);
    expect(cameraNameProblem('')).toMatch(/Enter a name/);
  });
});

describe('renameCamera', () => {
  it('saves, shows the name read back, and updates the picker', async () => {
    cameras.set([{ id: 'den', name: 'Den', webUiUrl: null }]);
    const calls = answer(200, { name: 'Backyard Left' });
    expect(await renameCamera('den', 'Backyard Left')).toEqual({ ok: true, name: 'Backyard Left' });
    expect(calls[0].url).toBe('/api/cameras/den/name');
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'Backyard Left' });
    expect(get(cameras)[0].name).toBe('Backyard Left');
  });

  it('shows the reason of a 400', async () => {
    cameras.set([{ id: 'den', name: 'Den', webUiUrl: null }]);
    answer(400, { error: 'invalid_name', reason: 'not allowed: =' });
    expect(await renameCamera('den', 'A=B')).toEqual({ ok: false, message: 'not allowed: =' });
    expect(get(cameras)[0].name).toBe('Den');
  });

  it('says "camera offline" on a 503', async () => {
    answer(503, { error: 'camera_offline' });
    expect(await renameCamera('den', 'X')).toEqual({ ok: false, message: 'Camera offline. Try again when it is back.' });
  });

  it('says the camera refused the change on a camera_error', async () => {
    answer(502, { error: 'camera_error' });
    expect(await renameCamera('den', 'X')).toEqual({ ok: false, message: 'The camera refused the change.' });
  });

  it('says it could not save otherwise', async () => {
    answer(502, { error: 'proxy_unavailable' });
    expect(await renameCamera('den', 'X')).toEqual({ ok: false, message: 'Could not save the name. Try again.' });
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network');
    });
    expect(await renameCamera('den', 'X')).toEqual({ ok: false, message: 'Could not save the name. Try again.' });
  });
});
