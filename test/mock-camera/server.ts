import express, { Express, Request, Response } from 'express';
import { readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';

// A stand-in for a Reolink camera's HTTP API, just enough for cams' client:
// Login/Logout, GetDevInfo, Snap and the FLV live endpoint. Used by unit tests
// and by the e2e suite; tests never touch a real camera.
export interface MockCameraOptions {
  user: string;
  password: string;
  model?: string;
  firmware?: string;
  // Delays the /flv response by this many ms, to let tests disconnect while
  // the client's openLive() call is still pending.
  flvDelayMs?: number;
}

export interface MockState {
  logins: number;
  loginAttempts: number;
  activeStreams: number;
  // GetDevInfo calls answered with a valid token (the client uses GetDevInfo
  // to check its session after a reset /flv connection).
  devInfoCalls: number;
  offline: boolean;
  // Resets every /flv connection, even one with a valid token, like a camera
  // whose stream service is broken rather than one that rejects the token.
  rejectAllStreams: boolean;
  revokeTokens(): void;
  // Forcibly ends every open /flv connection, simulating a camera-side drop
  // (reset, reboot) rather than the viewer leaving.
  dropStreams(): void;
}

export interface MockCamera {
  app: Express;
  state: MockState;
}

const FIXTURES = join(__dirname, 'fixtures');
const notLoggedIn = (cmd: string) => [{ cmd, code: 1, error: { detail: 'please login first', rspCode: -6 } }];
// What real firmware (RLC-1224A, v3.2.0.6011) answers a GET with a bad token:
// HTTP 200, Content-Type text/html, and this JSON as the body text.
const NOT_LOGGED_IN_GET_BODY = '[{"code":1,"error":{"rspCode":-6,"detail":"please login first"}}]';

interface FlvTag {
  ms: number;
  bytes: Buffer;
}

let fixture: { header: Buffer; tags: FlvTag[] } | undefined;

// Splits fixtures/live.flv into its file header and its tags (each with its
// trailing PreviousTagSize), keyed by the tag's timestamp in ms.
function liveFixture(): { header: Buffer; tags: FlvTag[] } {
  if (fixture) return fixture;
  const buf = readFileSync(join(FIXTURES, 'live.flv'));
  const headerEnd = buf.readUInt32BE(5) + 4; // header, then PreviousTagSize0
  const tags: FlvTag[] = [];
  for (let at = headerEnd; at + 11 <= buf.length; ) {
    const end = at + 11 + buf.readUIntBE(at + 1, 3) + 4;
    const ms = buf.readUIntBE(at + 4, 3) + buf[at + 7] * 0x1000000;
    tags.push({ ms, bytes: buf.subarray(at, end) });
    at = end;
  }
  fixture = { header: buf.subarray(0, headerEnd), tags };
  return fixture;
}

export function createMockCamera(opts: MockCameraOptions): MockCamera {
  const tokens = new Set<string>();
  const activeResponses = new Set<Response>();
  const state: MockState = {
    logins: 0,
    loginAttempts: 0,
    activeStreams: 0,
    devInfoCalls: 0,
    offline: false,
    rejectAllStreams: false,
    revokeTokens: () => tokens.clear(),
    dropStreams: () => {
      for (const res of activeResponses) res.destroy(new Error('mock camera dropped the stream'));
    },
  };
  const app = express();
  // Test-only introspection: needs no token, and is registered before the
  // "offline" middleware below so tests can still read state (e.g. that a
  // stream was already released) while the mock is simulating an outage.
  app.get('/__state', (_req: Request, res: Response) => {
    res.json({ activeStreams: state.activeStreams, logins: state.logins });
  });
  app.use((_req, res, next) => (state.offline ? res.status(503).end() : next()));
  app.use(express.json());

  const valid = (req: Request) => typeof req.query.token === 'string' && tokens.has(req.query.token);

  app.post('/cgi-bin/api.cgi', (req: Request, res: Response) => {
    const cmd = String(req.query.cmd ?? '');
    const param = Array.isArray(req.body) ? req.body[0]?.param : undefined;
    if (cmd === 'Login') {
      state.loginAttempts++;
      const u = param?.User;
      if (u?.userName !== opts.user || u?.password !== opts.password) {
        res.json([{ cmd, code: 1, error: { detail: 'login failed', rspCode: -7 } }]);
        return;
      }
      state.logins++;
      const name = randomBytes(8).toString('hex');
      tokens.add(name);
      res.json([{ cmd, code: 0, value: { Token: { leaseTime: 3600, name } } }]);
      return;
    }
    if (!valid(req)) {
      res.json(notLoggedIn(cmd));
      return;
    }
    if (cmd === 'Logout') {
      tokens.delete(String(req.query.token));
      res.json([{ cmd, code: 0, value: { rspCode: 200 } }]);
      return;
    }
    if (cmd === 'GetDevInfo') {
      state.devInfoCalls++;
      res.json([
        {
          cmd,
          code: 0,
          value: { DevInfo: { model: opts.model ?? 'RLC-1224A', firmVer: opts.firmware ?? 'v3.2.0.6011_mock', name: 'Mock' } },
        },
      ]);
      return;
    }
    res.json([{ cmd, code: 1, error: { detail: 'not supported by mock', rspCode: -9 } }]);
  });

  app.get('/cgi-bin/api.cgi', (req: Request, res: Response) => {
    if (req.query.cmd !== 'Snap' || !valid(req)) {
      res.status(200).type('text/html').send(NOT_LOGGED_IN_GET_BODY);
      return;
    }
    res.type('image/jpeg').sendFile(join(FIXTURES, 'snapshot.jpg'));
  });

  // Streams the fixture once, paced in real time by its FLV tag timestamps,
  // and then keeps the connection open, like a live camera that never ends a
  // stream on its own. Real time matters: a camera never bursts its whole
  // stream at once, and Chrome's software H.264 decoder (used on Linux) holds
  // back its last few frames until more input arrives, so a burst followed by
  // silence never starts playing there.
  app.get('/flv', (req: Request, res: Response) => {
    // Real firmware sends no HTTP response at all for a bad token: it just
    // closes the connection, so the client sees ECONNRESET / "socket hang up".
    if (state.rejectAllStreams || !valid(req)) {
      req.socket.destroy();
      return;
    }
    const start = () => {
      // The client may already have disconnected during the (optional)
      // delay above; don't count or serve a stream nobody is waiting for.
      if (res.destroyed || res.writableEnded) return;
      state.activeStreams++;
      activeResponses.add(res);
      const { header, tags } = liveFixture();
      const began = Date.now();
      let next = 0;
      const pump = () => {
        const due = Date.now() - began;
        while (next < tags.length && tags[next].ms <= due) res.write(tags[next++].bytes);
      };
      const timer = setInterval(() => {
        pump();
        if (next >= tags.length) clearInterval(timer);
      }, 20);
      res.on('close', () => {
        state.activeStreams--;
        activeResponses.delete(res);
        clearInterval(timer);
      });
      res.status(200).type('video/x-flv');
      res.write(header);
      pump();
    };
    if (opts.flvDelayMs) {
      setTimeout(start, opts.flvDelayMs);
    } else {
      start();
    }
  });

  return { app, state };
}
