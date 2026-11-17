import http from 'http';
import type { AddressInfo } from 'net';

// A server whose every answer is a 200 JSON list that keeps growing (no
// Content-Length) up to `limit` bytes, unless the client leaves first.
// `sent()`: the bytes it wrote, to show a reader stopped early.
export async function startEndlessJson(limit = 64 * 1024 * 1024): Promise<{ url: string; sent: () => number; stop: () => Promise<void> }> {
  let sent = 0;
  const chunk = Buffer.from('0,'.repeat(32 * 1024));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('[');
    const pump = () => {
      while (!res.destroyed && sent < limit) {
        sent += chunk.length;
        if (!res.write(chunk)) return void res.once('drain', pump);
      }
      if (!res.destroyed) res.end('0]');
    };
    pump();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sent: () => sent,
    stop: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}
