import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { createMockCamera, MockState } from './mock-camera/server';
import { CameraError, ReolinkClient } from '../server/reolink/client';
import { Semaphore } from '../server/reolink/semaphore';
import type { CameraConfig } from '../server/cameraRegistry';

let server: Server;
let state: MockState;
let cam: CameraConfig;

beforeEach(async () => {
  const mock = createMockCamera({ user: 'u', password: 'p' });
  state = mock.state;
  server = mock.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  cam = { id: 'cam1', name: 'Den', host: `127.0.0.1:${(server.address() as AddressInfo).port}`, protocol: 'http', user: 'u', password: 'p' };
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('ReolinkClient', () => {
  it('logs in once and reuses the token', async () => {
    const client = new ReolinkClient(cam);
    expect(await client.status()).toEqual({ model: 'RLC-1224A', firmware: 'v3.2.0.6011_mock' });
    await client.status();
    await client.status();
    expect(state.logins).toBe(1);
  });

  it('shares one login between concurrent first requests', async () => {
    const client = new ReolinkClient(cam);
    await Promise.all([client.status(), client.status(), client.status()]);
    expect(state.logins).toBe(1);
  });

  // Review focus 3: expired/invalidated token -> one transparent re-login.
  it('re-logs in once when the camera rejects the token', async () => {
    const client = new ReolinkClient(cam);
    await client.status();
    state.revokeTokens();
    expect((await client.status()).model).toBe('RLC-1224A');
    expect(state.logins).toBe(2);
  });

  it('renews the token before its lease runs out', async () => {
    let now = 1_000_000;
    const client = new ReolinkClient(cam, { now: () => now });
    await client.status();
    now += (3600 - 30) * 1000; // inside the 60 s renewal margin
    await client.status();
    expect(state.logins).toBe(2);
  });

  // Review focus 3: a wrong password must not cause a login storm.
  it('reports camera_auth_failed and backs off after a rejected login', async () => {
    let now = 1_000_000;
    const client = new ReolinkClient({ ...cam, password: 'wrong' }, { now: () => now });
    await expect(client.status()).rejects.toMatchObject({ code: 'camera_auth_failed' });
    await expect(client.status()).rejects.toMatchObject({ code: 'camera_auth_failed' });
    expect(state.logins).toBe(0);
    now += 31_000;
    await expect(client.status()).rejects.toMatchObject({ code: 'camera_auth_failed' });
  });

  it('reports camera_offline for an unreachable camera without leaking credentials', async () => {
    const client = new ReolinkClient({ ...cam, host: '127.0.0.1:9', password: 'hunter2-not-leaked' }, { timeoutMs: 1000 });
    const err = await client.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as CameraError).code).toBe('camera_offline');
    expect((err as CameraError).message).not.toMatch(/hunter2|127\.0\.0\.1|token=/);
  });

  it('reports camera_offline when the camera answers 503', async () => {
    const client = new ReolinkClient(cam);
    state.offline = true;
    await expect(client.status()).rejects.toMatchObject({ code: 'camera_offline' });
  });

  it('fetches a JPEG snapshot', async () => {
    const snap = await new ReolinkClient(cam).snapshot();
    expect(snap.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('opens a live FLV stream and closes it when aborted', async () => {
    const client = new ReolinkClient(cam);
    const ac = new AbortController();
    const stream = await client.openLive('sub', ac.signal);
    const first: Buffer = await new Promise((resolve) => stream.once('data', resolve));
    expect(first.subarray(0, 3).toString()).toBe('FLV');
    expect(state.activeStreams).toBe(1);
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect(state.activeStreams).toBe(0);
  });
});

describe('Semaphore', () => {
  it('never runs more than max tasks at once', async () => {
    const gate = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it('releases a slot when a task throws', async () => {
    const gate = new Semaphore(1);
    await expect(gate.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await gate.run(async () => 'ok')).toBe('ok');
  });
});
