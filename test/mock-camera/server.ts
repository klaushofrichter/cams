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
  // Delays sending the Download body by this many ms, to let tests abort a
  // download while it's still in flight.
  downloadDelayMs?: number;
  clips?: MockClip[];
}

export interface MockClip {
  daysAgo: number;
  start: string; // HHMMSS camera-local
  end: string;
  triggers: ('person' | 'vehicle' | 'pet' | 'motion')[];
}

// Four clips today, two yesterday: one per trigger, so filters and the
// timeline have something to show. Times are camera-local (America/Chicago).
export const DEFAULT_MOCK_CLIPS: MockClip[] = [
  { daysAgo: 0, start: '081510', end: '081535', triggers: ['person'] },
  { daysAgo: 0, start: '093000', end: '093020', triggers: ['vehicle'] },
  { daysAgo: 0, start: '120505', end: '120530', triggers: ['motion'] },
  { daysAgo: 0, start: '174540', end: '174605', triggers: ['pet'] },
  { daysAgo: 1, start: '070000', end: '070030', triggers: ['motion'] },
  { daysAgo: 1, start: '221510', end: '221540', triggers: ['person'] },
];

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
  downloads: number;
  activeDownloads: number;
  revokeTokens(): void;
  // Forcibly ends every open /flv connection, simulating a camera-side drop
  // (reset, reboot) rather than the viewer leaving.
  dropStreams(): void;
  // Forcibly ends every open Download response, simulating the camera
  // dropping the connection mid-transfer.
  dropDownloads(): void;
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

const TZ = 'America/Chicago';
const TRIGGER_POS: Record<string, number> = { person: 17, vehicle: 19, pet: 20, motion: 24 };
// Base flags of a real sub/main clip without trigger bits; see clipNames.ts.
const BASE_FLAGS = { sub: 0x55148000000000n, main: 0x7b288200000000n };

function flagsHex(stream: 'sub' | 'main', triggers: string[]): string {
  let v = BASE_FLAGS[stream];
  for (const t of triggers) v |= 1n << BigInt(55 - TRIGGER_POS[t]);
  return v.toString(16).toUpperCase().padStart(14, '0');
}

function chicagoParts(d: Date): { date: string; dst: boolean } {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' }).format(d);
  return { date, dst: /CDT/.test(name) };
}

// Steps back `days` calendar days from `date` (YYYY-MM-DD) using UTC-date
// arithmetic, not by subtracting days*86400s from a wall-clock instant:
// the latter can land a day early or late whenever the Chicago-local time
// of day, combined with a DST transition somewhere in the intervening
// days, crosses a local midnight boundary.
function stepBackDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Whether DST is in effect in `TZ` on `date`. Evaluated at noon (UTC) of
// that date rather than at the clip's own time - acceptable since a clip
// only needs its DST flag to match its own calendar date, and noon is far
// from either transition hour.
function isDstOn(date: string): boolean {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' }).format(new Date(`${date}T12:00:00Z`));
  return /CDT/.test(name);
}

function clipNames(clip: MockClip, stream: 'sub' | 'main'): { name: string; size: number; date: string } {
  const date = stepBackDate(chicagoParts(new Date()).date, clip.daysAgo);
  const dst = isDstOn(date);
  const ymd = date.replaceAll('-', '');
  const size = stream === 'sub' ? 0x927c9 : 0x4eb60d;
  const base = `Rec${stream === 'sub' ? 'S' : 'M'}0A_${dst ? 'DST' : ''}${ymd}_${clip.start}_${clip.end}_0_${flagsHex(stream, clip.triggers)}_${size.toString(16).toUpperCase()}.mp4`;
  return { name: `/mnt/sda/Mp4Record/${date}/${base}`, size, date };
}

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
  const activeDownloadResponses = new Set<Response>();
  const state: MockState = {
    logins: 0,
    loginAttempts: 0,
    activeStreams: 0,
    devInfoCalls: 0,
    offline: false,
    rejectAllStreams: false,
    downloads: 0,
    activeDownloads: 0,
    revokeTokens: () => tokens.clear(),
    dropStreams: () => {
      for (const res of activeResponses) res.destroy(new Error('mock camera dropped the stream'));
    },
    dropDownloads: () => {
      for (const res of activeDownloadResponses) res.destroy(new Error('mock camera dropped the download'));
    },
  };
  const app = express();
  // Test-only introspection: needs no token, and is registered before the
  // "offline" middleware below so tests can still read state (e.g. that a
  // stream was already released) while the mock is simulating an outage.
  app.get('/__state', (_req: Request, res: Response) => {
    res.json({
      activeStreams: state.activeStreams,
      logins: state.logins,
      downloads: state.downloads,
      activeDownloads: state.activeDownloads,
    });
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
    if (cmd === 'GetTime') {
      res.json([{ cmd, code: 0, value: { Time: { timeZone: 21600, isDst: chicagoParts(new Date()).dst ? 1 : 0 }, Dst: { enable: 1, offset: 1 } } }]);
      return;
    }
    if (cmd === 'Search') {
      const s = param?.Search ?? {};
      const stream: 'sub' | 'main' = s.streamType === 'main' ? 'main' : 'sub';
      const clips = opts.clips ?? DEFAULT_MOCK_CLIPS;
      const startDate = `${s.StartTime.year}-${String(s.StartTime.mon).padStart(2, '0')}-${String(s.StartTime.day).padStart(2, '0')}`;
      const endDate = `${s.EndTime.year}-${String(s.EndTime.mon).padStart(2, '0')}-${String(s.EndTime.day).padStart(2, '0')}`;
      const named = clips.map((c) => clipNames(c, stream)).filter((c) => c.date >= startDate && c.date <= endDate);
      if (s.onlyStatus === 1) {
        const table = Array.from({ length: 31 }, (_, i) =>
          named.some((c) => Number(c.date.slice(8, 10)) === i + 1 && Number(c.date.slice(5, 7)) === s.StartTime.mon) ? '1' : '0',
        ).join('');
        res.json([{ cmd, code: 0, value: { SearchResult: { channel: 0, Status: [{ year: s.StartTime.year, mon: s.StartTime.mon, table }] } } }]);
        return;
      }
      const File = named.map((c) => ({ name: c.name, size: String(c.size), type: stream, frameRate: 0, width: 0, height: 0 }));
      res.json([{ cmd, code: 0, value: { SearchResult: { channel: 0, ...(File.length ? { File } : {}) } } }]);
      return;
    }
    res.json([{ cmd, code: 1, error: { detail: 'not supported by mock', rspCode: -9 } }]);
  });

  app.get('/cgi-bin/api.cgi', (req: Request, res: Response) => {
    if (req.query.cmd === 'Download') {
      if (!valid(req)) {
        // Firmware: HTTP 401, text/html, empty body.
        res.status(401).type('text/html').end();
        return;
      }
      const source = String(req.query.source ?? '');
      const stream = /\/RecM/.test(source) ? 'main' : 'sub';
      state.downloads++;
      state.activeDownloads++;
      activeDownloadResponses.add(res);
      res.on('close', () => {
        state.activeDownloads--;
        activeDownloadResponses.delete(res);
      });
      const send = () => {
        // The client may already have disconnected during the (optional)
        // delay below; don't try to serve a file to a closed response.
        if (res.destroyed || res.writableEnded) return;
        res.type('video/mp4').sendFile(join(FIXTURES, `clip-${stream}.mp4`));
      };
      if (opts.downloadDelayMs) setTimeout(send, opts.downloadDelayMs);
      else send();
      return;
    }
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
