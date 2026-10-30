import { apiFetch, UnauthorizedError } from './api';

// The PTZ panel's calls (cams's /api/cameras/:id/ptz/…, passed through to
// cam-proxy; spec 2026-10-30-ptz-capabilities-design §5), its words, and the
// name rules the browser checks before asking.

export type Direction = 'left' | 'right' | 'up' | 'down' | 'left-up' | 'left-down' | 'right-up' | 'right-down';
export interface PtzCapabilities {
  move: boolean;
  zoom: boolean;
  focus: boolean;
  speed: boolean;
  positions: { max: number } | null;
}
export interface Capabilities {
  schema: number;
  ptz: PtzCapabilities | null;
}
export interface PtzPosition {
  id: string;
  name: string;
  order: number;
  home: boolean;
  state: 'ok' | 'missing';
}
export interface PtzPositions {
  max: number;
  positions: PtzPosition[];
}

// A refused call: the HTTP status (0: no answer) and the body's `error`.
export class PtzError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(code ?? `HTTP ${status}`);
  }
}

async function call<T>(cam: string, path: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(`/api/cameras/${encodeURIComponent(cam)}/ptz${path}`, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e;
    throw new PtzError(0, null);
  }
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const code = (json as { error?: unknown } | null)?.error;
    throw new PtzError(res.status, typeof code === 'string' ? code : null);
  }
  return json as T;
}

export function ptzApi(cam: string) {
  const none = async (p: Promise<unknown>) => void (await p);
  return {
    move: (d: Direction, durationMs: number) => none(call(cam, '/move', 'POST', { direction: d, durationMs })),
    zoom: (d: 'in' | 'out', durationMs: number) => none(call(cam, '/zoom', 'POST', { direction: d, durationMs })),
    focus: (d: 'near' | 'far', durationMs: number) => none(call(cam, '/focus', 'POST', { direction: d, durationMs })),
    stop: () => none(call(cam, '/stop', 'POST', {})),
    positions: () => call<PtzPositions>(cam, '/positions', 'GET'),
    save: (name: string) => call<PtzPosition>(cam, '/positions', 'POST', { name }),
    rename: (id: string, name: string) => none(call(cam, `/positions/${encodeURIComponent(id)}`, 'PATCH', { name })),
    makeHome: (id: string) => none(call(cam, `/positions/${encodeURIComponent(id)}`, 'PATCH', { home: true })),
    order: (ids: string[]) => none(call(cam, '/positions/order', 'PUT', { ids })),
    resave: (id: string) => none(call(cam, `/positions/${encodeURIComponent(id)}/save`, 'POST', {})),
    go: (id: string) => none(call(cam, `/positions/${encodeURIComponent(id)}/go`, 'POST', {})),
    remove: (id: string) => none(call(cam, `/positions/${encodeURIComponent(id)}`, 'DELETE')),
  };
}
export type PtzApi = ReturnType<typeof ptzApi>;

const TEXT: Record<string, string> = {
  not_supported: "This camera can't do that.",
  camera_offline: 'The camera is offline.',
  camera_error: "The camera didn't accept that. Try again.",
  proxy_unavailable: "The camera's cam-proxy can't be reached.",
  limit_reached: 'No room for more positions. Delete one first.',
  no_free_slot: 'The camera has no free preset slot left.',
  position_missing: 'This position is no longer on the camera. Save it again.',
  home_position: "Home can't be deleted while other positions exist. Make another position Home first.",
  name_taken: 'That name is already used.',
};

// What the panel says about a failed call.
export function ptzErrorText(e: unknown): string {
  if (!(e instanceof PtzError)) return "That didn't work.";
  if (e.status === 0) return TEXT.proxy_unavailable;
  if (e.code && TEXT[e.code]) return TEXT[e.code];
  if (e.status === 400) return "That wasn't accepted. Check the name (1–40 characters, not used yet).";
  if (e.status === 429) return 'Too many requests. Wait a moment.';
  return `That didn't work (HTTP ${e.status}).`;
}

export const NAME_MAX = 40;
const key = (s: string) => s.trim().toLowerCase();

// "Position N": the lowest N ≥ 1 not taken (ignoring case).
export function defaultPositionName(list: PtzPosition[]): string {
  const taken = new Set(list.map((p) => key(p.name)));
  let n = 1;
  while (taken.has(`position ${n}`)) n++;
  return `Position ${n}`;
}

// What is wrong with a name (the proxy's rules), or null. `exceptId`: the
// position being renamed.
export function checkPositionName(name: string, list: PtzPosition[], exceptId?: string): string | null {
  const t = name.trim();
  if (!t) return 'Give the position a name.';
  if ([...t].length > NAME_MAX) return `Names are at most ${NAME_MAX} characters.`;
  if (list.some((p) => p.id !== exceptId && key(p.name) === key(t))) return 'Another position already has that name.';
  return null;
}

// The ids with the one at `from` moved to `to`.
export function moveId(ids: string[], from: number, to: number): string[] {
  const out = [...ids];
  const [id] = out.splice(from, 1);
  out.splice(to, 0, id);
  return out;
}
