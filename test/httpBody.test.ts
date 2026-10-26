import { describe, expect, it } from 'vitest';
import { contentLength, nodeBody } from '../server/httpBody';

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
