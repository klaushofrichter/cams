import { Readable } from 'stream';
import type { ReadableStream } from 'stream/web';

// A fetch Response's body as a Node stream (for pipeline into an Express
// response or a file). The cast bridges the DOM and Node stream types.
export const nodeBody = (res: globalThis.Response): Readable => Readable.fromWeb(res.body as ReadableStream);

// A Content-Length header as a number of bytes; null when absent or not a
// plain decimal.
export const contentLength = (v: string | string[] | null | undefined): number | null => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

// The part of a fetch Response (global or undici) that readCapped reads.
interface CappedSource {
  headers: { get(name: string): string | null };
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }; cancel(): Promise<void> } | null;
}

// A fetch Response's body, read up to `max` bytes: a larger one, by
// Content-Length or while reading, is cancelled (and `ctl` aborted) and
// `tooLarge()` thrown, so it is never held in memory.
export async function readCapped(res: CappedSource, max: number, tooLarge: () => Error, ctl?: AbortController): Promise<Buffer> {
  const refuse = (cancel?: () => Promise<void>) => {
    void cancel?.().catch(() => undefined);
    ctl?.abort();
    return tooLarge();
  };
  const body = res.body;
  if ((contentLength(res.headers.get('content-length')) ?? 0) > max) throw refuse(body ? () => body.cancel() : undefined);
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    size += value.byteLength;
    if (size > max) throw refuse(() => reader.cancel());
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
