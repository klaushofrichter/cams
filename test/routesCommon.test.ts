import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { msRange, viewerGone } from '../server/routes/common';

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
