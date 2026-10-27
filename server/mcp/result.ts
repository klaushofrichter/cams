// Tool results (spec 2026-10-27-mcp-server-design §3, §8): structured content
// plus the same JSON as text; errors as isError with {error, message,
// retryable}, in short sentences for the model, never upstream text.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ErrorCode =
  | 'invalid' | 'unknown_camera' | 'no_proxy' | 'camera_offline' | 'camera_error' | 'proxy_unavailable' | 'too_old'
  | 'not_found' | 'range_too_large' | 'too_long' | 'nothing_kept' | 'busy' | 'image_too_large' | 'rate_limited' | 'forbidden';

const MESSAGES: Record<ErrorCode, string> = {
  invalid: 'The request is not valid.',
  unknown_camera: 'There is no camera with that id in this account. Call list_cameras for the ids.',
  no_proxy: 'This camera has no cam-proxy, which keeps its stills, archive and clips.',
  camera_offline: 'The camera is not reachable right now.',
  camera_error: 'The camera refused the request.',
  proxy_unavailable: "The camera's cam-proxy is not reachable right now.",
  too_old: "The camera's cam-proxy is too old for this.",
  not_found: 'Nothing was found for that id or time.',
  range_too_large: 'The time range is too long.',
  too_long: 'The clip would be too long.',
  nothing_kept: 'Nothing is kept for that time any more.',
  busy: 'A clip for this account is already being made. Ask get_clip_job about it, then try again.',
  image_too_large: 'The image is too large to return.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  forbidden: 'This token may not do that.',
};
const RETRYABLE = new Set<ErrorCode>(['camera_offline', 'proxy_unavailable', 'busy', 'rate_limited']);

export interface Image { data: Buffer; mime: 'image/jpeg' }

export function ok(data: Record<string, unknown>, images: Image[] = []): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }, ...images.map((i) => ({ type: 'image' as const, data: i.data.toString('base64'), mimeType: i.mime }))],
    structuredContent: data,
  };
}

export function fail(code: ErrorCode, message: string = MESSAGES[code], retryable = RETRYABLE.has(code)): CallToolResult {
  const body = { error: code, message, retryable };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}

// A thrown ToolFailure ends a tool with that error (see server.ts).
export class ToolFailure extends Error {
  constructor(public code: ErrorCode, message?: string) {
    super(message ?? MESSAGES[code]);
  }
}

// An /api error answer as a tool error code.
export function codeOf(status: number, body: unknown): ErrorCode {
  const e = (body as { error?: unknown } | null)?.error;
  const known: Record<string, ErrorCode> = {
    unknown_camera: 'unknown_camera', no_proxy: 'no_proxy', too_old: 'too_old', not_found: 'not_found', unknown_clip: 'not_found',
    no_clip: 'not_found', camera_offline: 'camera_offline', camera_auth: 'camera_offline', camera_error: 'camera_error',
    camera_address_unknown: 'camera_offline', proxy_unavailable: 'proxy_unavailable', too_long: 'too_long', rate_limited: 'rate_limited',
    forbidden_role: 'forbidden', forbidden: 'forbidden', invalid: 'invalid', bad_request: 'invalid', stills_disabled: 'not_found',
  };
  if (typeof e === 'string' && known[e]) return known[e];
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'busy';
  if (status >= 400 && status < 500) return 'invalid';
  return 'proxy_unavailable';
}

// A failed /api answer as a ToolFailure (its detail kept only for `invalid`
// and `too_long`, which are cams's own words).
export async function failureOf(r: Response): Promise<ToolFailure> {
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    /* not JSON */
  }
  const code = codeOf(r.status, body);
  const detail = (body as { detail?: unknown } | null)?.detail;
  return new ToolFailure(code, (code === 'invalid' || code === 'too_long') && typeof detail === 'string' ? detail.slice(0, 160) : undefined);
}

// ISO 8601 with an offset (or Z), or unix ms; null otherwise.
export function parseTime(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
