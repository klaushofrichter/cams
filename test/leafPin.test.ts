// The one place cams opens TLS without chain validation (server/tls/leafPin.ts):
// a camera's leaf pin, checked at secureConnect before any byte is written.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import https from 'https';
import { join } from 'path';
import { certFingerprint } from '../server/tls/fingerprint';
import { connectPinned, pinnedConnection } from '../server/tls/leafPin';
import { startTlsCamera } from './helpers/tlsCamera';

const SELF = certFingerprint(readFileSync(join(__dirname, 'fixtures/site-ca/selfsigned.pem')));
const timeout = () => new Error('timeout');
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((s) => s()));
});
async function cam() {
  const c = await startTlsCamera('selfsigned');
  stops.push(c.stop);
  const [host, port] = c.host.split(':');
  return { ...c, hostname: host, port: Number(port) };
}
const get = (c: { hostname: string; port: number }, fingerprint: string) =>
  new Promise<string>((resolve) => {
    const req = https.request({ hostname: c.hostname, port: c.port, path: '/x', method: 'POST', createConnection: pinnedConnection(fingerprint, 2000, timeout), agent: undefined }, (res) => {
      res.resume();
      resolve(String(res.statusCode));
    });
    req.on('error', (err: { code?: string }) => resolve(`error ${err.code}`));
    req.end('{"secret":"password"}');
  });

describe('leaf pin', () => {
  it('lets a request through to the certificate with that fingerprint', async () => {
    expect(await get(await cam(), SELF)).toBe('200');
  });

  it('refuses any other certificate before a single byte is sent', async () => {
    const c = await cam();
    expect(await get(c, 'ab'.repeat(32))).toBe('error ERR_TLS_CERT_PIN_MISMATCH');
    await new Promise((r) => setTimeout(r, 50));
    expect(c.received()).toBe(0);
  });

  it('connectPinned hands over the socket only on a match', async () => {
    const c = await cam();
    const outcome = (fp: string) =>
      new Promise<string>((resolve) => {
        const s = connectPinned({ host: c.hostname, port: c.port }, fp, 2000, timeout, (err) => {
          s.destroy();
          resolve(err ? (err as { code?: string }).code ?? 'error' : 'ok');
        });
      });
    expect(await outcome(SELF)).toBe('ok');
    expect(await outcome('cd'.repeat(32))).toBe('ERR_TLS_CERT_PIN_MISMATCH');
    expect(c.received()).toBe(0);
  });
});
