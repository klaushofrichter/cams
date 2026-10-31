// The fMP4 (MSE) live player for cameras behind a cam-proxy (spec §10.3):
// cams relays the proxy's fMP4 as chunked HTTP; this plays it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fmp4Player } from './fmp4Player';
import { browserCodecs, CODEC_CANDIDATES, liveUrl } from './live';

const MIME = 'video/mp4; codecs="avc1.640029"';

class FakeSourceBuffer extends EventTarget {
  updating = false;
  mode = 'sequence';
  appended: Uint8Array[] = [];
  removed: [number, number][] = [];
  quota = false;
  onRemove: (start: number, end: number) => void = () => undefined; // what the browser's buffer does
  appendBuffer(b: Uint8Array) {
    if (this.updating) throw new Error('InvalidStateError: append while updating');
    if (this.quota) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    this.updating = true;
    this.appended.push(b);
    setTimeout(() => {
      this.updating = false;
      this.dispatchEvent(new Event('updateend'));
    }, 1);
  }
  remove(start: number, end: number) {
    this.updating = true;
    this.removed.push([start, end]);
    this.onRemove(start, end);
    setTimeout(() => {
      this.updating = false;
      this.dispatchEvent(new Event('updateend'));
    }, 1);
  }
}

let sb: FakeSourceBuffer;
let types: string[];
class FakeMediaSource extends EventTarget {
  static supported = true;
  static isTypeSupported = (t: string) => FakeMediaSource.supported && t.startsWith('video/mp4');
  readyState = 'closed';
  constructor() {
    super();
    setTimeout(() => {
      this.readyState = 'open';
      this.dispatchEvent(new Event('sourceopen'));
    }, 0);
  }
  addSourceBuffer(t: string) {
    types.push(t);
    return sb;
  }
  endOfStream() {}
}

interface FakeVideo { src: string; currentTime: number; buf: [number, number] | null; buffered: { length: number; start(i: number): number; end(i: number): number }; play(): Promise<void>; removeAttribute(n: string): void; load(): void; disableRemotePlayback?: boolean }
function video(): FakeVideo {
  const v: FakeVideo = {
    src: '',
    currentTime: 0,
    buf: null,
    buffered: { get length() { return v.buf ? 1 : 0; }, start: () => v.buf![0], end: () => v.buf![1] },
    play: () => Promise.resolve(),
    removeAttribute: (n: string) => void (n === 'src' && (v.src = '')),
    load: () => undefined,
  };
  return v;
}

// A response body the test feeds chunk by chunk.
function body() {
  let c!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (x) => void (c = x) });
  return { stream, push: (n: number) => c.enqueue(new Uint8Array([n])), end: () => c.close() };
}

let fetchMock: ReturnType<typeof vi.fn>;
let signals: AbortSignal[];
beforeEach(() => {
  sb = new FakeSourceBuffer();
  types = [];
  signals = [];
  FakeMediaSource.supported = true;
  vi.stubGlobal('MediaSource', FakeMediaSource);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function start(response: Response | Promise<Response>) {
  fetchMock.mockImplementation((_u: string, init: RequestInit) => {
    signals.push(init.signal!);
    return Promise.resolve(response);
  });
  const v = video();
  const p = fmp4Player('/api/cameras/den/live?quality=sub');
  const failures = vi.fn();
  p.onFailure(failures);
  p.attach(v as unknown as HTMLVideoElement);
  p.load();
  return { v, p, failures };
}
const ok = (stream: ReadableStream<Uint8Array>, type = MIME) => new Response(stream, { status: 200, headers: { 'Content-Type': type } });

describe('fmp4Player', () => {
  it('appends chunks in order, one at a time, with the response\'s type', async () => {
    const b = body();
    const { v } = start(ok(b.stream));
    expect(v.src).toBe('blob:fake');
    b.push(1);
    b.push(2);
    b.push(3);
    await vi.waitFor(() => expect(sb.appended.map((x) => x[0])).toEqual([1, 2, 3]));
    expect(types).toEqual([MIME]);
    expect(sb.mode).toBe('segments');
  });

  it('fails once when the body ends', async () => {
    const b = body();
    const { failures } = start(ok(b.stream));
    b.push(1);
    b.end();
    await vi.waitFor(() => expect(failures).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(failures).toHaveBeenCalledTimes(1);
  });

  it('fails on a 503 and on a type the browser refuses', async () => {
    const a = start(new Response('{"error":"camera_offline"}', { status: 503 }));
    await vi.waitFor(() => expect(a.failures).toHaveBeenCalledTimes(1));
    FakeMediaSource.supported = false;
    const b = start(ok(body().stream));
    await vi.waitFor(() => expect(b.failures).toHaveBeenCalledTimes(1));
  });

  it('fails on a SourceBuffer error and on a full buffer', async () => {
    const b = body();
    const a = start(ok(b.stream));
    b.push(1);
    await vi.waitFor(() => expect(sb.appended).toHaveLength(1));
    sb.dispatchEvent(new Event('error'));
    expect(a.failures).toHaveBeenCalledTimes(1);
    sb = new FakeSourceBuffer();
    sb.quota = true;
    const c = body();
    const d = start(ok(c.stream));
    c.push(1);
    await vi.waitFor(() => expect(d.failures).toHaveBeenCalledTimes(1));
  });

  it('jumps ahead past 1.5 s of latency and drops what is 30 s behind', async () => {
    const b = body();
    const { v } = start(ok(b.stream));
    v.buf = [0, 45];
    v.currentTime = 40;
    sb.onRemove = (_s, end) => void (v.buf = [end, v.buf![1]]);
    b.push(1);
    await vi.waitFor(() => expect(v.currentTime).toBeCloseTo(44.7));
    await vi.waitFor(() => expect(sb.removed).toEqual([[0, 44.7 - 30]]));
  });

  it('aborts the fetch and detaches on destroy', async () => {
    const b = body();
    const { v, p } = start(ok(b.stream));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    p.destroy();
    expect(signals[0].aborted).toBe(true);
    expect(v.src).toBe('');
  });
});

describe('browserCodecs and liveUrl', () => {
  it('names the candidates the browser takes', () => {
    expect(browserCodecs(() => true)).toBe(CODEC_CANDIDATES.join(','));
    expect(browserCodecs((t) => !t.includes('hvc1'))).toBe('avc1.640029,avc1.64002A,avc1.640033,mp4a.40.2');
    expect(browserCodecs(() => false)).toBe('');
  });

  it('adds codecs to the live URL when given', () => {
    expect(liveUrl('den', 'sub')).toBe('/api/cameras/den/live?quality=sub');
    expect(liveUrl('den', 'main', 'avc1.640029,hvc1.1.6.L153.B0')).toBe('/api/cameras/den/live?quality=main&codecs=avc1.640029%2Chvc1.1.6.L153.B0');
    expect(liveUrl('den', 'main', '')).toBe('/api/cameras/den/live?quality=main');
  });
});
