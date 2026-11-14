import { EventEmitter } from 'events';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { viewerGone } from '../server/routes/common';

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
