// The browser relay (/api/events/stream) checks the session for as long as
// it stays open, not only at connect: a member removed from the account (or
// a viewer token revoked, both arrive as a new configuration) loses the
// stream at once, and anything else that ends the session (expiry) at the
// next keep-alive at the latest (code review 2026-11-09, item 1).
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../server/app';
import { setCameras } from '../server/cameraRegistry';
import { stopProxyStreams } from '../server/proxy/stream';
import { BETA, applyFleet, cookieFor, restoreMode, twoAccounts } from './helpers/fleet';
import jwt from 'jsonwebtoken';
import { SESSION_COOKIE } from '../server/session';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  stopProxyStreams();
  restoreMode();
  setCameras([]);
});

async function openStream(cookie: string): Promise<{ ended: Promise<void>; status: number; close: () => Promise<void> }> {
  const server = http.createServer(createApp()).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events/stream', headers: { Cookie: cookie } }, (res) => {
      const ended = new Promise<void>((r) => {
        res.on('end', () => r());
        res.on('close', () => r());
      });
      res.resume();
      resolve({
        ended,
        status: res.statusCode ?? 0,
        close: async () => {
          req.destroy();
          server.closeAllConnections();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

const within = (p: Promise<void>, ms: number) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

describe('the event stream re-checks the session', () => {
  it('ends when the member is removed from the account (a new configuration)', async () => {
    applyFleet(twoAccounts());
    const s = await openStream(cookieFor('both@example.org', BETA));
    try {
      expect(s.status).toBe(200);
      expect(await within(s.ended, 100)).toBe(false); // still a member: stays open
      applyFleet(twoAccounts({ betaRemoved: 'both@example.org' }));
      expect(await within(s.ended, 1000)).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('stays open across a new configuration that keeps the member', async () => {
    applyFleet(twoAccounts());
    const s = await openStream(cookieFor('both@example.org', BETA));
    try {
      applyFleet(twoAccounts({ betaRole: 'admin' }));
      expect(await within(s.ended, 200)).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('ends at the next keep-alive once the session is no longer valid (here: it expired)', async () => {
    applyFleet(twoAccounts());
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // A session that expires in a second (a normal one lasts 7 days).
    const short = jwt.sign({ email: 'both@example.org', acc: BETA }, process.env.COOKIE_SECRET as string, { algorithm: 'HS256', expiresIn: 1 });
    const s = await openStream(`${SESSION_COOKIE}=${short}`);
    try {
      expect(s.status).toBe(200);
      await new Promise((r) => setTimeout(r, 1100));
      vi.advanceTimersByTime(30_000);
      vi.useRealTimers();
      expect(await within(s.ended, 1000)).toBe(true);
    } finally {
      await s.close();
    }
  });
});
