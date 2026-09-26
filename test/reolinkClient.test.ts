import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AddressInfo } from 'net';
import { Server } from 'http';
import express from 'express';
import { createMockCamera, MockState } from './mock-camera/server';
import { CameraError, ReolinkClient, classifyNetworkError } from '../server/reolink/client';
import { Semaphore } from '../server/reolink/semaphore';
import type { CameraConfig } from '../server/cameraRegistry';

let server: Server;
let state: MockState;
let cam: CameraConfig;

// Guards a regression test against a permanent hang: on the pre-fix
// deadlock, the awaited promise never settles, so without this the test
// runner itself would hang forever instead of failing.
function withDeadline<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('deadlock')), ms)),
  ]);
}

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

  // Review focus 3 / Review Important 2: a wrong password must not cause a
  // login storm. state.logins only counts successful logins, so assert on
  // loginAttempts (incremented on every Login call, success or not).
  it('reports camera_auth_failed and backs off after a rejected login', async () => {
    let now = 1_000_000;
    const client = new ReolinkClient({ ...cam, password: 'wrong' }, { now: () => now });
    await expect(client.status()).rejects.toMatchObject({ code: 'camera_auth_failed' });
    await expect(client.status()).rejects.toMatchObject({ code: 'camera_auth_failed' });
    expect(state.loginAttempts).toBe(1);
    expect(state.logins).toBe(0);
    now += 31_000;
    await expect(client.status()).rejects.toMatchObject({ code: 'camera_auth_failed' });
    expect(state.loginAttempts).toBe(2);
  });

  it('reports camera_offline for an unreachable camera without leaking credentials', async () => {
    const client = new ReolinkClient({ ...cam, host: '127.0.0.1:9', password: 'hunter2-not-leaked' }, { timeoutMs: 1000 });
    const err = await client.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as CameraError).code).toBe('camera_offline');
    expect((err as CameraError).message).not.toMatch(/hunter2|127\.0\.0\.1|token=/);
  });

  it('reports camera_offline when the camera drops the connection', async () => {
    const client = new ReolinkClient(cam);
    state.offline = true;
    await expect(client.status()).rejects.toMatchObject({ code: 'camera_offline' });
  });

  it('fetches a JPEG snapshot', async () => {
    const snap = await new ReolinkClient(cam).snapshot();
    expect(snap.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  // Review Important 4: careful re-login for GET endpoints (Snap/FLV) -
  // only a 403 or a rspCode -6 body (whatever its content type) justifies
  // clearing the token.
  it('re-logs in once for a snapshot when the token is revoked', async () => {
    const client = new ReolinkClient(cam);
    await client.snapshot();
    state.revokeTokens();
    const snap = await client.snapshot();
    expect(snap.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(state.logins).toBe(2);
  });

  // Review Important 3: a snapshot's full request (open + body read) must
  // stay inside the per-camera concurrency gate, same as JSON commands.
  it('keeps snapshots within the per-camera concurrency cap', async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const mock = createMockCamera({ user: 'u', password: 'p' });
    state = mock.state;

    const counter = { active: 0, peak: 0 };
    const outer = express();
    outer.use((_req, res, next) => {
      counter.active++;
      counter.peak = Math.max(counter.peak, counter.active);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        counter.active--;
      };
      res.on('finish', finish);
      res.on('close', finish);
      next();
    });
    outer.use(mock.app);
    server = outer.listen(0);
    await new Promise((r) => server.once('listening', r));
    cam = { ...cam, host: `127.0.0.1:${(server.address() as AddressInfo).port}` };

    const client = new ReolinkClient(cam, { maxConcurrent: 1 });
    await client.status(); // prime the login so the burst below needs none

    await Promise.all([client.snapshot(), client.snapshot(), client.snapshot(), client.status()]);

    expect(counter.peak).toBe(1);
  });

  // Critical (round 2): snapshot() held a gate slot while getToken()'s
  // login also needed the gate, deadlocking permanently. getToken() must
  // run outside the gate.
  describe('snapshot does not deadlock on the concurrency gate', () => {
    it('a fresh client with maxConcurrent 1 can snapshot with no priming', async () => {
      const client = new ReolinkClient(cam, { maxConcurrent: 1 });
      const snap = await withDeadline(client.snapshot());
      expect(snap.subarray(0, 2).toString('hex')).toBe('ffd8');
    });

    it('two concurrent snapshots after a token revoke both succeed with exactly one re-login, and the client stays usable', async () => {
      const client = new ReolinkClient(cam);
      await client.status();
      const attemptsBefore = state.loginAttempts;
      state.revokeTokens();

      const [snap1, snap2] = await withDeadline(Promise.all([client.snapshot(), client.snapshot()]));
      expect(snap1.subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(snap2.subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(state.loginAttempts - attemptsBefore).toBe(1);

      // (c) the camera isn't left wedged: a normal call still works.
      const status = await withDeadline(client.status());
      expect(status.model).toBe('RLC-1224A');
    });
  });

  // Final review Critical 1: how the real firmware (RLC-1224A v3.2.0.6011)
  // reports a rejected token on its GET endpoints. Snap answers HTTP 200
  // text/html with a rspCode -6 JSON body; /flv resets the connection
  // without any HTTP response. Both must recover with exactly one re-login.
  describe('token rejection as the real firmware reports it', () => {
    it('snapshot recovers from a text/html rspCode -6 reply with exactly one re-login', async () => {
      const client = new ReolinkClient(cam);
      await client.status();
      const attemptsBefore = state.loginAttempts;
      state.revokeTokens();
      const snap = await withDeadline(client.snapshot());
      expect(snap.subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(state.loginAttempts - attemptsBefore).toBe(1);
    });

    it('openLive recovers from a reset /flv connection with exactly one re-login', async () => {
      const client = new ReolinkClient(cam);
      await client.status();
      const attemptsBefore = state.loginAttempts;
      state.revokeTokens();
      const ac = new AbortController();
      const stream = await withDeadline(client.openLive('sub', ac.signal));
      try {
        const first: Buffer = await withDeadline(new Promise((resolve) => stream.once('data', resolve)));
        expect(first.subarray(0, 3).toString()).toBe('FLV');
        expect(state.loginAttempts - attemptsBefore).toBe(1);
      } finally {
        ac.abort();
      }
    });

    it('openLive reports camera_offline without a re-login when /flv resets even with a valid token', async () => {
      const client = new ReolinkClient(cam);
      await client.status();
      const attemptsBefore = state.loginAttempts;
      const devInfoBefore = state.devInfoCalls;
      state.rejectAllStreams = true;
      await expect(withDeadline(client.openLive('sub', new AbortController().signal))).rejects.toMatchObject({
        code: 'camera_offline',
      });
      expect(state.loginAttempts - attemptsBefore).toBe(0);
      // The session was validated once (GetDevInfo), and the open wasn't retried
      // with the same token.
      expect(state.devInfoCalls - devInfoBefore).toBe(1);
    });
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

  // Review Important 1: active-- must not happen before the woken waiter has
  // claimed the slot, or a newcomer can sneak in during that gap.
  it('hands the slot to the waiting caller without letting a newcomer grab it first', async () => {
    const gate = new Semaphore(1);
    let active = 0;
    let peak = 0;

    // Holds the slot for a moment so an overlapping newcomer is observable.
    const hold = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };

    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const taskA = gate.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await aGate;
      // Right as A is about to release, a newcomer C also tries to acquire
      // the gate. The extra microtask hop lands C's attempt right after the
      // Semaphore's own finally block runs (which resolves queued waiter B),
      // but before B's continuation has resumed and re-claimed the slot.
      queueMicrotask(() => {
        queueMicrotask(() => {
          void gate.run(hold);
        });
      });
      active--;
    });

    // Let A actually acquire the slot (its run() call is synchronous up to
    // the first await).
    await Promise.resolve();

    const taskB = gate.run(hold);

    // Let B's run() call reach the "push onto waiting" point.
    await Promise.resolve();

    releaseA();

    await Promise.all([taskA, taskB]);
    // Give the queued newcomer C time to run too.
    await new Promise((r) => setTimeout(r, 20));

    expect(peak).toBe(1);
  });
});

describe('ReolinkClient recordings', () => {
  it('refuses to download a recording name with unexpected characters', async () => {
    const client = new ReolinkClient(cam);
    await expect(client.download('/mnt/sda/x.mp4&cmd=Reboot')).rejects.toMatchObject({ code: 'camera_error' });
    await expect(client.download('/mnt/sda/a b.mp4')).rejects.toMatchObject({ code: 'camera_error' });
  });

  // Firmware: two Searches at once fail with rspCode -54 (the other may come
  // back empty), so the client must run a camera's searches one at a time.
  it('runs concurrent searches one at a time, like the firmware needs', async () => {
    const client = new ReolinkClient(cam);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    const [sub, main, days] = await Promise.all([
      client.searchDay(today, 'sub'),
      client.searchDay(today, 'main'),
      client.searchMonth(today.slice(0, 7)),
    ]);
    expect(sub.length).toBeGreaterThan(0);
    expect(main.length).toBe(sub.length);
    expect(days).toContain(today);
  });

  it('reads camera time into offsets and caches it', async () => {
    const client = new ReolinkClient(cam);
    const t = await client.timeInfo();
    expect(t).toEqual({ stdOffsetMinutes: -360, dstOffsetMinutes: 60 });
    await client.timeInfo();
    // one GetTime only: cached
  });

  it('lists a day of clips with numeric sizes', async () => {
    const client = new ReolinkClient(cam);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    const files = await client.searchDay(today, 'sub');
    expect(files.length).toBeGreaterThan(0);
    expect(typeof files[0].size).toBe('number');
    expect(files[0].name).toMatch(/RecS0A_/);
  });

  it('returns [] for a day without clips', async () => {
    const client = new ReolinkClient(cam);
    expect(await client.searchDay('2001-01-01', 'sub')).toEqual([]);
  });

  it('lists days of a month that have recordings', async () => {
    const client = new ReolinkClient(cam);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    expect(await client.searchMonth(today.slice(0, 7))).toContain(today);
  });

  // Firmware: Download with a bad token answers 401 text/html (empty).
  it('re-logs in once when a download is rejected with 401', async () => {
    const client = new ReolinkClient(cam);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    const [file] = await client.searchDay(today, 'sub');
    state.revokeTokens();
    const before = state.loginAttempts;
    const res = await client.download(file.name);
    expect(res.headers['content-type']).toBe('video/mp4');
    res.resume();
    expect(state.loginAttempts - before).toBe(1);
  });
});

// Review Minor 6: TLS certificate failures are a security signal, not
// "the camera is offline".
describe('classifyNetworkError', () => {
  it('maps TLS/certificate errors to camera_error', () => {
    for (const code of [
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'CERT_HAS_EXPIRED',
    ]) {
      const err = classifyNetworkError(Object.assign(new Error('tls'), { code }));
      expect(err.code).toBe('camera_error');
      expect(err.message).toContain(code);
    }
  });

  it('maps other network errors to camera_offline', () => {
    expect(classifyNetworkError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })).code).toBe(
      'camera_offline',
    );
    expect(classifyNetworkError(new Error('boom')).code).toBe('camera_offline');
  });
});
