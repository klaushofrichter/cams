import { describe, expect, it } from 'vitest';
import { contentLength, nodeBody, readCapped } from '../server/httpBody';

describe('contentLength', () => {
  it('reads a plain decimal and nothing else', () => {
    expect(contentLength('1234')).toBe(1234);
    expect(contentLength('0')).toBe(0);
    for (const v of [null, undefined, '', ' 12', '12a', '-1', '1.5', ['12']]) expect(contentLength(v)).toBeNull();
  });
});

describe('nodeBody', () => {
  it('streams a fetch body as a Node stream', async () => {
    const chunks: Buffer[] = [];
    for await (const c of nodeBody(new Response('hello'))) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });
});

describe('readCapped', () => {
  const tooLarge = () => new Error('too_large');
  // A body that arrives in chunks, without a Content-Length.
  const chunked = (parts: string[]) =>
    new Response(new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } }));

  it('reads a body under the cap', async () => {
    expect((await readCapped(new Response('hello'), 5, tooLarge)).toString()).toBe('hello');
    expect((await readCapped(chunked(['ab', 'cd']), 4, tooLarge)).toString()).toBe('abcd');
  });
  it('refuses by Content-Length before reading, and aborts the controller', async () => {
    const ctl = new AbortController();
    const res = new Response('0123456789', { headers: { 'content-length': '10' } });
    await expect(readCapped(res, 4, tooLarge, ctl)).rejects.toThrow('too_large');
    expect(ctl.signal.aborted).toBe(true);
  });
  it('refuses while streaming once the running size passes the cap', async () => {
    const ctl = new AbortController();
    await expect(readCapped(chunked(['abc', 'def']), 4, tooLarge, ctl)).rejects.toThrow('too_large');
    expect(ctl.signal.aborted).toBe(true);
  });
  it('gives an empty buffer for no body', async () => {
    expect((await readCapped(new Response(null), 4, tooLarge)).length).toBe(0);
  });
});
