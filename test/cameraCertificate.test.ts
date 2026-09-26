import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { createServer as createTlsServer, Server as TlsServer } from 'tls';
import { createServer as createTcpServer, Server as TcpServer, AddressInfo } from 'net';
import { join } from 'path';
import { ReolinkClient } from '../server/reolink/client';

// A test-only self-signed certificate (CN=cam1.test.local), committed as a fixture.
const key = readFileSync(join(__dirname, 'fixtures/tls-key.pem'));
const cert = readFileSync(join(__dirname, 'fixtures/tls-cert.pem'));
let server: TlsServer | TcpServer | null = null;
const sockets = new Set<import('net').Socket>();
afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

const client = (host: string, timeoutMs = 2000) =>
  new ReolinkClient({ id: 'cam1', name: 'Den', host, protocol: 'https', tlsServername: 'cam1.test.local', user: 'u', password: 'p' }, { timeoutMs, tlsCa: cert });

async function listen(s: TlsServer | TcpServer, host = '127.0.0.1'): Promise<number> {
  server = s;
  s.on('connection', (sock) => sockets.add(sock));
  await new Promise<void>((r) => s.listen(0, host, () => r()));
  return (s.address() as AddressInfo).port;
}

describe('cameraCertificate', () => {
  it('reads subject, issuer and expiry without sending anything', async () => {
    let received = 0;
    const port = await listen(createTlsServer({ key, cert }, (sock) => sock.on('data', (d) => (received += d.length))));
    const c = await client(`127.0.0.1:${port}`).cameraCertificate();
    expect(c).toMatchObject({ subject: 'cam1.test.local', issuer: 'cams test CA' });
    expect(Date.parse(c!.validTo)).toBeGreaterThan(Date.now());
    expect(received).toBe(0);
  });

  it('works with a bracketed IPv6 host', async () => {
    const port = await listen(createTlsServer({ key, cert }), '::1');
    expect((await client(`[::1]:${port}`).cameraCertificate())?.subject).toBe('cam1.test.local');
  });

  it('does not trust a certificate that fails verification', async () => {
    const port = await listen(createTlsServer({ key, cert }));
    const untrusting = new ReolinkClient({ id: 'cam1', name: 'Den', host: `127.0.0.1:${port}`, protocol: 'https', tlsServername: 'cam1.test.local', user: 'u', password: 'p' }, { timeoutMs: 2000 });
    expect(await untrusting.cameraCertificate()).toBeNull();
  });

  it('does not accept a certificate for a different name', async () => {
    const port = await listen(createTlsServer({ key, cert }));
    const wrongName = new ReolinkClient({ id: 'cam1', name: 'Den', host: `127.0.0.1:${port}`, protocol: 'https', tlsServername: 'other.example', user: 'u', password: 'p' }, { timeoutMs: 2000, tlsCa: cert });
    expect(await wrongName.cameraCertificate()).toBeNull();
  });

  it('gives up with null when the handshake never completes', async () => {
    const port = await listen(createTcpServer(() => {}));
    expect(await client(`127.0.0.1:${port}`, 200).cameraCertificate()).toBeNull();
  });
});
