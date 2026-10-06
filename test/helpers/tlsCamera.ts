// A TLS server with one of the site-CA fixture certificates that answers
// like a camera's API (a fixed JSON reply) and counts the request bytes it
// received after the handshake.
import { readFileSync } from 'fs';
import https from 'https';
import type { AddressInfo } from 'net';
import { join } from 'path';

const fx = (n: string) => readFileSync(join(__dirname, '../fixtures/site-ca', n));

export async function startTlsCamera(name: 'cam-a' | 'selfsigned' | 'outside-a', reply: (cmd: string) => unknown = (cmd) => [{ cmd, code: 0, value: {} }]) {
  let received = 0;
  const server = https.createServer({ key: fx(`${name}.key`), cert: fx(`${name}.pem`) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const cmd = /cmd=([A-Za-z]+)/.exec(req.url ?? '')?.[1] ?? 'x';
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply(cmd)));
    });
  });
  server.on('secureConnection', (s) => s.on('data', (d: Buffer) => (received += d.length)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    received: () => received,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
