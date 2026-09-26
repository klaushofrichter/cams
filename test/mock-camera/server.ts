import express, { Express, Request, Response } from 'express';
import { createReadStream } from 'fs';
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
  offline: boolean;
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

export function createMockCamera(opts: MockCameraOptions): MockCamera {
  const tokens = new Set<string>();
  const activeResponses = new Set<Response>();
  const state: MockState = {
    logins: 0,
    loginAttempts: 0,
    activeStreams: 0,
    offline: false,
    revokeTokens: () => tokens.clear(),
    dropStreams: () => {
      for (const res of activeResponses) res.destroy(new Error('mock camera dropped the stream'));
    },
  };
  const app = express();
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
      res.json(notLoggedIn(String(req.query.cmd ?? '')));
      return;
    }
    res.type('image/jpeg').sendFile(join(FIXTURES, 'snapshot.jpg'));
  });

  // Streams the fixture once and then keeps the connection open, like a live
  // camera that never ends a stream on its own.
  app.get('/flv', (req: Request, res: Response) => {
    if (!valid(req)) {
      res.status(403).end();
      return;
    }
    const start = () => {
      // The client may already have disconnected during the (optional)
      // delay above; don't count or serve a stream nobody is waiting for.
      if (res.destroyed || res.writableEnded) return;
      state.activeStreams++;
      activeResponses.add(res);
      const file = createReadStream(join(FIXTURES, 'live.flv'));
      file.on('error', () => res.destroy());
      res.on('close', () => {
        state.activeStreams--;
        activeResponses.delete(res);
        file.destroy();
      });
      res.status(200).type('video/x-flv');
      file.pipe(res, { end: false });
    };
    if (opts.flvDelayMs) {
      setTimeout(start, opts.flvDelayMs);
    } else {
      start();
    }
  });

  return { app, state };
}
