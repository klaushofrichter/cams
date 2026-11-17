import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { ProxyError } from '../server/proxy/client';
import { msRange, passUnsatisfiable, readJson, upstreamHeader, viewerGone } from '../server/routes/common';

// A response stand-in: only 'close' and writableFinished matter here.
const fakeRes = (finished: boolean) => Object.assign(new EventEmitter(), { writableFinished: finished }) as unknown as Response;

describe('viewerGone', () => {
  it('aborts when the response closes before it finished', () => {
    const res = fakeRes(false);
    const signal = viewerGone(res);
    expect(signal.aborted).toBe(false);
    res.emit('close');
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe('AbortError');
  });
  it('does not abort after a normal finish', () => {
    const res = fakeRes(true);
    const signal = viewerGone(res);
    res.emit('close');
    expect(signal.aborted).toBe(false);
  });
});

describe('msRange', () => {
  const run = (query: Record<string, string>, maxDays = 1) => {
    let sent: { status?: number; body?: unknown } = {};
    const res = { status: (s: number) => ({ json: (b: unknown) => void (sent = { status: s, body: b }) }) } as unknown as Response;
    const out = msRange({ query } as unknown as Request, res, maxDays, 'one day');
    return { out, sent };
  };
  it('gives the range when from <= to and within the limit', () => {
    expect(run({ from: '1000', to: '86401000' }).out).toEqual([1000, 86_401_000]);
  });
  it('answers 400 for a missing, reversed or too long range', () => {
    expect(run({ from: '5' }).sent).toEqual({ status: 400, body: { error: 'invalid', detail: 'from and to (unix ms) are required' } });
    expect(run({ from: '5', to: '4' }).out).toBeUndefined();
    expect(run({ from: '0', to: '86400001' }).sent).toEqual({ status: 400, body: { error: 'invalid', detail: 'at most one day per request' } });
  });
});

// A proxy answer is read up to a cap, never whole (code review 2026-11-14):
// over it, a ProxyError (502 proxy_unavailable in the routes).
describe('readJson', () => {
  const big = (n: number) => JSON.stringify({ pad: 'x'.repeat(n) });
  it('reads a JSON answer, null for an empty or non-JSON one', async () => {
    expect(await readJson(new Response('{"a":1}'))).toEqual({ a: 1 });
    expect(await readJson(new Response(''))).toBeNull();
    expect(await readJson(new Response('nope'))).toBeNull();
  });
  it('refuses an answer over 64 KiB, by length or while reading', async () => {
    await expect(readJson(new Response(big(70_000)))).rejects.toBeInstanceOf(ProxyError);
    const chunked = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode('x'.repeat(10_000))); c.close(); } }));
    await expect(readJson(chunked)).rejects.toBeInstanceOf(ProxyError);
    expect(await readJson(new Response(big(60_000)))).toMatchObject({ pad: expect.any(String) });
  });
  it('takes a larger cap where an answer can be large', async () => {
    expect(await readJson(new Response(big(200_000)), 1024 * 1024)).toMatchObject({ pad: expect.any(String) });
  });
});

describe('upstreamHeader', () => {
  const up = new Response(null, { headers: { 'Content-Length': '1234', 'Content-Range': `bytes 0-1/${'9'.repeat(16)}` } });
  it('gives a header of the expected form, undefined for another or a missing one', () => {
    expect(upstreamHeader(up, 'content-length', /^\d{1,15}$/)).toBe('1234');
    expect(upstreamHeader(up, 'content-range', /^bytes \d{1,15}-\d{1,15}\/\d{1,15}$/)).toBeUndefined();
    expect(upstreamHeader(up, 'etag', /.*/)).toBeUndefined();
  });
});

describe('passUnsatisfiable', () => {
  const run = async (up: globalThis.Response, extra?: Record<string, string>) => {
    const sent: { status?: number; headers?: Record<string, string>; ended?: boolean } = {};
    const res = {
      status(s: number) {
        sent.status = s;
        return this;
      },
      set(h: Record<string, string>) {
        sent.headers = h;
        return this;
      },
      end() {
        sent.ended = true;
      },
    } as unknown as Response;
    await passUnsatisfiable(up, res, extra);
    return sent;
  };
  it('answers 416 with the proxy\'s bytes */N and the route\'s extras, and cancels the body', async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    const sent = await run(new Response(body, { status: 416, headers: { 'Content-Range': 'bytes */16' } }), { 'Accept-Ranges': 'bytes' });
    expect(sent).toEqual({ status: 416, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes */16' }, ended: true });
    expect(cancelled).toBe(true);
  });
  it('leaves out a Content-Range of another form', async () => {
    const sent = await run(new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${'1'.repeat(16)}` } }));
    expect(sent).toEqual({ status: 416, headers: {}, ended: true });
  });
});
