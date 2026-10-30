import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPositionName, defaultPositionName, moveId, ptzApi, PtzError, ptzErrorText, type PtzPosition } from './ptz';

const pos = (id: string, name: string, extra: Partial<PtzPosition> = {}): PtzPosition => ({ id, name, order: 0, home: false, state: 'ok', ...extra });

describe('position names', () => {
  it('suggests the lowest unused "Position N"', () => {
    expect(defaultPositionName([])).toBe('Position 1');
    expect(defaultPositionName([pos('a', 'Position 1'), pos('b', 'position 3')])).toBe('Position 2');
    expect(defaultPositionName([pos('a', 'Position 2')])).toBe('Position 1');
  });

  it('says what is wrong with a name, or null', () => {
    expect(checkPositionName('  ', [])).toBe('Give the position a name.');
    expect(checkPositionName('x'.repeat(41), [])).toBe('Names are at most 40 characters.');
    expect(checkPositionName(' gate ', [pos('a', 'Gate')])).toBe('Another position already has that name.');
    expect(checkPositionName('Gate', [pos('a', 'Gate')], 'a')).toBeNull();
    expect(checkPositionName('x'.repeat(40), [])).toBeNull();
    expect(checkPositionName('\u{1F469}\u200D\u{1F4BB} Desk', [])).toBeNull();
    expect(checkPositionName('a\u0007b', [])).toBe("Names can't contain control characters.");
  });
});

describe('moveId', () => {
  it('moves one id to another place', () => {
    expect(moveId(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveId(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveId(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('ptzErrorText', () => {
  it.each([
    [new PtzError(404, 'not_supported'), "This camera can't do that."],
    [new PtzError(503, 'camera_offline'), 'The camera is offline.'],
    [new PtzError(502, 'camera_error'), "The camera didn't accept that. Try again."],
    [new PtzError(502, 'proxy_unavailable'), "The camera's cam-proxy can't be reached."],
    [new PtzError(0, null), "The camera's cam-proxy can't be reached."],
    [new PtzError(409, 'limit_reached'), 'No room for more positions. Delete one first.'],
    [new PtzError(409, 'no_free_slot'), 'The camera has no free preset slot left.'],
    [new PtzError(409, 'position_missing'), 'This position is no longer on the camera. Save it again.'],
    [new PtzError(409, 'home_position'), "Home can't be deleted while other positions exist. Make another position Home first."],
    [new PtzError(409, 'name_taken'), 'That name is already used.'],
    [new PtzError(400, 'invalid'), "That wasn't accepted. Check the name (1–40 characters, not used yet)."],
    [new PtzError(429, null), 'Too many requests. Wait a moment.'],
    [new PtzError(500, 'internal'), "That didn't work (HTTP 500)."],
    [new Error('x'), "That didn't work."],
  ])('%o', (e, text) => expect(ptzErrorText(e)).toBe(text));
});

describe('ptzApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(answer: () => Response) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
        return answer();
      }),
    );
    return calls;
  }
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const empty = () => new Response(null, { status: 204 });

  it('sends a move and rejects a refusal with its status and code', async () => {
    const calls = stub(empty);
    await ptzApi('den').move('left', 400);
    expect(calls).toEqual([{ url: '/api/cameras/den/ptz/move', method: 'POST', body: { direction: 'left', durationMs: 400 } }]);
    stub(json(503, { error: 'camera_offline' }));
    const err = await ptzApi('den').move('left', 400).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PtzError);
    expect([(err as PtzError).status, (err as PtzError).code]).toEqual([503, 'camera_offline']);
  });

  it('a network failure is PtzError(0, null)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network'))));
    const err = (await ptzApi('den').stop().catch((e: unknown) => e)) as PtzError;
    expect([err.status, err.code]).toEqual([0, null]);
  });

  it('calls every route with its method and body', async () => {
    const calls = stub(json(200, { max: 20, positions: [] }));
    const api = ptzApi('a b');
    await api.zoom('in', 600);
    await api.focus('far', 400);
    await api.stop();
    expect(await api.positions()).toEqual({ max: 20, positions: [] });
    await api.save('Gate');
    await api.rename('pos_1', 'Door');
    await api.makeHome('pos_1');
    await api.order(['pos_2', 'pos_1']);
    await api.resave('pos_1');
    await api.go('pos_1');
    await api.remove('pos_1');
    const base = '/api/cameras/a%20b/ptz';
    expect(calls).toEqual([
      { url: `${base}/zoom`, method: 'POST', body: { direction: 'in', durationMs: 600 } },
      { url: `${base}/focus`, method: 'POST', body: { direction: 'far', durationMs: 400 } },
      { url: `${base}/stop`, method: 'POST', body: {} },
      { url: `${base}/positions`, method: 'GET', body: undefined },
      { url: `${base}/positions`, method: 'POST', body: { name: 'Gate' } },
      { url: `${base}/positions/pos_1`, method: 'PATCH', body: { name: 'Door' } },
      { url: `${base}/positions/pos_1`, method: 'PATCH', body: { home: true } },
      { url: `${base}/positions/order`, method: 'PUT', body: { ids: ['pos_2', 'pos_1'] } },
      { url: `${base}/positions/pos_1/save`, method: 'POST', body: {} },
      { url: `${base}/positions/pos_1/go`, method: 'POST', body: {} },
      { url: `${base}/positions/pos_1`, method: 'DELETE', body: undefined },
    ]);
  });
});
