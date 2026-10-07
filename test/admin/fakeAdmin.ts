// A stand-in for cams-admin's cams service API (contract/cams-v1, migration
// spec §9.2, M §12.3): enrollment, the signed config snapshot (ETag/304),
// tokens, retire and report — signed answers with the vectors' `server`
// key, signed requests checked in the contract's order. Switches make it
// misbehave: unsigned, wrongKey, skewBy, down/up, slow, oversize.
// Tests set its state directly; e2e runs it as a process (e2e/fakeAdmin.ts).
import express, { type Request, type Response } from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Socket } from 'net';
import { createHash, randomBytes } from 'crypto';
import { jcs } from '../../server/admin/jcs';
import { answerText, enrollText, privateFromB64, publicFromB64, requestText, sha256hex, signText, verifyText } from '../../server/admin/sign';
import vectors from '../../contract/cams-v1/vectors.json';

export const SERVER_KEY = vectors.keys.server;
export const OTHER_KEY = vectors.keys.other;
export const CAMS_KEY = vectors.keys.cams;
const serverPriv = privateFromB64(SERVER_KEY.privateKey);
const otherPriv = privateFromB64(OTHER_KEY.privateKey);

export const fingerprintOf = (spkiB64: string): string => 'SHA256:' + createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').toUpperCase();
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const randomCode = () => {
  const body = Array.from(randomBytes(20), (b) => CROCKFORD[b % 32]).join('');
  return `CAC1-${body.match(/.{4}/g)!.join('-')}`;
};
export function normaliseCamsCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!s.startsWith('CAC1')) return null;
  const body = s.slice(4);
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(body)) return null;
  return `CAC1-${body.match(/.{4}/g)!.join('-')}`;
}

export type Snapshot = Record<string, unknown>;
export interface FakeTokenRow { tokenId: string; proxyId: string; kind: 'client' | 'admin'; hash: string; state: 'pending' | 'active' | 'retiring' | 'revoked'; retireAt: number | null }
export interface FakeRequest { method: string; path: string; headers: Record<string, string | undefined>; body: string; status: number; error?: string }

export interface FakeAdmin {
  url: string;
  code: string;
  instanceId: string;
  instanceName: string;
  keyId: string;
  accounts: string[];
  fingerprint: string;
  publicKey: string | null; // the enrolled instance key
  keyState: 'none' | 'pending' | 'active';
  snapshot: Snapshot | null; // without sig: signed when served
  tokens: FakeTokenRow[];
  registered: { proxyId: string; kind: string; hash: string }[];
  reports: Record<string, unknown>[];
  requests: FakeRequest[];
  configGets: number;
  // switches
  unsigned: boolean;
  wrongKey: boolean;
  oversize: boolean;
  slowMs: number;
  tokenAnswer: { status: number; body: Record<string, unknown> } | null; // the next POST /tokens answers this
  revoked: boolean; // the instance is blocked: 403 revoked (contract step 7)
  skewBy(ms: number): void;
  down(): void;
  up(): void;
  setSnapshot(s: Snapshot | null): void;
  signedSnapshot(): Snapshot | null;
  stop(): Promise<void>;
}

const NONCE = /^[A-Za-z0-9_-]{22}$/;

export function signSnapshot(s: Snapshot, key: 'server' | 'other' = 'server'): Snapshot {
  const { sig: _drop, ...rest } = s;
  void _drop;
  return { ...rest, sig: signText(key === 'server' ? serverPriv : otherPriv, jcs(rest)) };
}

export async function startFakeAdmin(o: { port?: number; instanceId?: string; instanceName?: string; accounts?: string[] } = {}): Promise<FakeAdmin> {
  let skew = 0;
  let isDown = false;
  const seen = new Set<string>();
  const fake: FakeAdmin = {
    url: '',
    code: randomCode(),
    instanceId: o.instanceId ?? 'cms_00000000000000000001',
    instanceName: o.instanceName ?? 'cluster',
    keyId: 'key_00000000000000000001',
    accounts: o.accounts ?? ['home'],
    fingerprint: fingerprintOf(SERVER_KEY.publicKey),
    publicKey: null,
    keyState: 'none',
    snapshot: null,
    tokens: [],
    registered: [],
    reports: [],
    requests: [],
    configGets: 0,
    unsigned: false,
    wrongKey: false,
    oversize: false,
    slowMs: 0,
    tokenAnswer: null,
    revoked: false,
    skewBy(ms) {
      skew = ms;
    },
    down() {
      isDown = true;
      for (const s of sockets) s.destroy();
    },
    up() {
      isDown = false;
    },
    setSnapshot(s) {
      fake.snapshot = s;
    },
    signedSnapshot() {
      return fake.snapshot && signSnapshot(fake.snapshot);
    },
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const serverNow = () => Date.now() + skew;

  const app = express();
  app.use(express.raw({ type: () => true, limit: '64kb' }));
  app.use((req, res, next) => {
    if (fake.slowMs) setTimeout(next, fake.slowMs);
    else next();
  });

  // Signed answer (every answer of a request past check 1).
  function answer(req: Request, res: Response, status: number, body: unknown, extra: Record<string, string> = {}) {
    const nonce = String(req.get('x-cams-nonce') ?? '');
    let bytes = status === 304 || body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    if (fake.oversize && status === 200) bytes = Buffer.concat([Buffer.from('{"pad":"'), Buffer.alloc(1_200_000, 0x61), Buffer.from('"}')]);
    const headers: Record<string, string> = { ...extra };
    if (!fake.unsigned) headers['X-Cams-Admin-Sig'] = signText(fake.wrongKey ? otherPriv : serverPriv, answerText(status, nonce, bytes));
    if (bytes.length) headers['Content-Type'] = 'application/json';
    res.status(status).set(headers);
    fake.requests.push({ method: req.method, path: req.originalUrl, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])), body: (req.body as Buffer | undefined)?.toString('utf8') ?? '', status, error: (body as { error?: string } | undefined)?.error });
    res.end(bytes);
  }

  app.post('/cams/v1/enroll', (req, res) => {
    let b: { v?: unknown; code?: unknown; publicKey?: unknown; proof?: unknown; camsVersion?: unknown };
    try {
      b = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      return void res.status(400).json({ error: 'bad_request' });
    }
    fake.requests.push({ method: 'POST', path: '/cams/v1/enroll', headers: {}, body: (req.body as Buffer).toString('utf8'), status: 0 });
    if (b.v !== 1 || typeof b.publicKey !== 'string' || typeof b.proof !== 'string' || typeof b.camsVersion !== 'string') return void res.status(400).json({ error: 'bad_request' });
    const code = normaliseCamsCode(b.code);
    if (!code || code !== fake.code) return void res.status(401).json({ error: 'invalid_code' });
    let ok = false;
    try {
      ok = verifyText(publicFromB64(b.publicKey), enrollText(code, b.publicKey), b.proof);
    } catch {
      ok = false;
    }
    if (!ok) return void res.status(400).json({ error: 'bad_proof' });
    fake.code = randomCode(); // used
    fake.publicKey = b.publicKey;
    fake.keyState = 'pending';
    res.status(201).json({ v: 1, instanceId: fake.instanceId, instanceName: fake.instanceName, keyId: fake.keyId, accounts: fake.accounts, serverKeys: [SERVER_KEY.publicKey], serverKeyFingerprints: [fake.fingerprint], apiUrl: fake.url });
  });

  // The contract's check order, steps 1 and 3–6.
  app.use('/cams/v1', (req, res, next) => {
    const h = (n: string) => req.get(n);
    const body = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    const ts = Number(h('x-cams-ts'));
    if (!h('x-cams-instance') || !h('x-cams-key') || !Number.isSafeInteger(ts) || !NONCE.test(h('x-cams-nonce') ?? '') || !h('x-cams-sig')) {
      return void res.status(400).json({ error: 'bad_request' });
    }
    if (!fake.publicKey || h('x-cams-key') !== fake.keyId || h('x-cams-instance') !== fake.instanceId) return answer(req, res, 401, { error: 'unknown_key' });
    const text = requestText(req.method, req.originalUrl, ts, h('x-cams-nonce')!, body);
    if (!verifyText(publicFromB64(fake.publicKey), text, h('x-cams-sig'))) return answer(req, res, 401, { error: 'bad_signature' });
    if (Math.abs(ts - serverNow()) > 300_000) return answer(req, res, 401, { error: 'clock_skew', serverTime: serverNow() });
    if (seen.has(h('x-cams-nonce')!)) return answer(req, res, 401, { error: 'replayed' });
    seen.add(h('x-cams-nonce')!);
    if (fake.revoked) return answer(req, res, 403, { error: 'revoked' });
    fake.keyState = 'active';
    next();
  });

  app.get('/cams/v1/config', (req, res) => {
    fake.configGets++;
    const s = fake.signedSnapshot();
    if (!s) return answer(req, res, 404, { error: 'not_found' });
    const etag = `"${String(s.revision)}"`;
    if (req.get('if-none-match') === etag) return answer(req, res, 304, undefined, { ETag: etag });
    answer(req, res, 200, s, { ETag: etag });
  });

  app.post('/cams/v1/tokens', (req, res) => {
    const b = JSON.parse((req.body as Buffer).toString('utf8') || '{}') as { proxyId?: string; kind?: 'client' | 'admin'; hash?: string };
    fake.registered.push({ proxyId: String(b.proxyId), kind: String(b.kind), hash: String(b.hash) });
    if (fake.tokenAnswer) {
      const a = fake.tokenAnswer;
      fake.tokenAnswer = null;
      return answer(req, res, a.status, a.body);
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(b.hash ?? '')) return answer(req, res, 400, { error: 'invalid', field: 'hash' });
    const same = fake.tokens.find((t) => t.hash === b.hash);
    if (same) {
      if (same.proxyId !== b.proxyId || same.kind !== b.kind) return answer(req, res, 409, { error: 'hash_in_use' });
      return answer(req, res, 200, { tokenId: same.tokenId, state: same.state, label: `cams ${fake.instanceName}${same.kind === 'admin' ? ' admin' : ''}` });
    }
    const pending = fake.tokens.find((t) => t.proxyId === b.proxyId && t.kind === b.kind && t.state === 'pending');
    if (pending) return answer(req, res, 409, { error: 'pending_exists', tokenId: pending.tokenId });
    const row: FakeTokenRow = { tokenId: `tok_${randomBytes(10).toString('hex').toUpperCase().slice(0, 20)}`, proxyId: b.proxyId!, kind: b.kind!, hash: b.hash!, state: 'pending', retireAt: null };
    fake.tokens.push(row);
    answer(req, res, 201, { tokenId: row.tokenId, state: 'pending', label: `cams ${fake.instanceName}${row.kind === 'admin' ? ' admin' : ''}` });
  });

  app.post('/cams/v1/tokens/:tokenId/retire', (req, res) => {
    const b = JSON.parse((req.body as Buffer).toString('utf8') || '{}') as { hours?: number };
    const row = fake.tokens.find((t) => t.tokenId === req.params.tokenId);
    if (!row) return answer(req, res, 404, { error: 'not_found' });
    if (row.state !== 'active') return answer(req, res, 409, { error: 'not_active' });
    row.state = 'retiring';
    row.retireAt = serverNow() + (b.hours ?? 24) * 3_600_000;
    answer(req, res, 200, { tokenId: row.tokenId, state: 'retiring', retireAt: row.retireAt });
  });

  app.post('/cams/v1/report', (req, res) => {
    const r = JSON.parse((req.body as Buffer).toString('utf8') || '{}') as Record<string, unknown>;
    fake.reports.push(r);
    const revision = String(fake.snapshot?.revision ?? 'r:0000000000000000');
    answer(req, res, 200, { changed: r.appliedRevision !== revision, revision });
  });

  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    if (isDown) return void req.socket.destroy();
    app(req, res);
  });
  server.on('connection', (s) => {
    if (isDown) return void s.destroy();
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

// The body hash of a recorded request (for tests that check what was sent).
export const bodySha = (r: FakeRequest) => sha256hex(r.body);
