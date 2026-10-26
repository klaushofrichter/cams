import { Readable } from 'stream';
import type { ReadableStream } from 'stream/web';

// A fetch Response's body as a Node stream (for pipeline into an Express
// response or a file). The cast bridges the DOM and Node stream types.
export const nodeBody = (res: globalThis.Response): Readable => Readable.fromWeb(res.body as ReadableStream);

// A Content-Length header as a number of bytes; null when absent or not a
// plain decimal.
export const contentLength = (v: string | string[] | null | undefined): number | null => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
