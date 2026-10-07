export class UnauthorizedError extends Error {}

// A refused request, with the server's `error` code when it sent one.
export class HttpError extends Error {
  constructor(
    url: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`${url} returned HTTP ${status}`);
  }
}

// --- Expired session (issue #153, R2) ---------------------------------------
//
// Every request the app makes goes through apiFetch (getJson, putJson,
// postJson and the raw fetches), and images, videos and the event stream,
// which can't see a status, ask checkSession() when they fail. A 401 whose
// body is {"error":"unauthorized"} is cams's own "not signed in"
// (server/middleware/requireAuth.ts); a camera or cam-proxy refusing its
// credentials answers 502/503 with its own code and is never taken for it.
//
// Then, once per page: first a silent renewal (the server asks Google with
// prompt=none for the account of the last sign-in), back to this very page;
// if that was already tried in the last few minutes, or Google wants the
// user, the start page, whose sign-in also comes back here.

export const SESSION_EXPIRED_CODE = 'unauthorized';
export const SILENT_KEY = 'cams.silentRenewalAt';
export const SILENT_GAP_MS = 5 * 60 * 1000;
const PROBE_GAP_MS = 30 * 1000;

// The web copy of the server's safeReturnPath (server/middleware/requireAuth.ts).
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^\/app(?:[/?#]|$)/.test(value)) return null;
  if (value.includes('//') || value.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 2048) return null;
  const path = value.split(/[?#]/)[0];
  if (path.split('/').some((seg) => /^(\.|%2e){1,2}$/i.test(seg))) return null;
  return value;
}

// Where to go to sign in again: the silent renewal unless one was tried in
// the last SILENT_GAP_MS (in this tab), else the start page. Without
// sessionStorage (private mode, blocked) no silent attempt: it could loop.
export function renewalUrl(here: string, store: Pick<Storage, 'getItem' | 'setItem'> | null, now = Date.now()): string {
  const query = `returnTo=${encodeURIComponent(safeReturnPath(here) ?? '/app')}`;
  let silent = false;
  try {
    if (store) {
      const last = Number(store.getItem(SILENT_KEY));
      if (!(last > 0 && now - last >= 0 && now - last < SILENT_GAP_MS)) {
        store.setItem(SILENT_KEY, String(now));
        silent = true;
      }
    }
  } catch {
    silent = false;
  }
  return silent ? `/auth/google/login?silent=1&${query}` : `/?${query}`;
}

function sessionStore(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

let leaving = false;

// One page load leaves once, however many requests failed at the same time.
export function sessionExpired(): void {
  if (leaving) return;
  leaving = true;
  location.assign(renewalUrl(location.pathname + location.search + location.hash, sessionStore()));
}

// Several accounts and none chosen (migration P4, R4-13): the server answers
// 409 choose_account to everything but the picker's calls; the app opens
// the picker, once per page.
export const CHOOSE_ACCOUNT_CODE = 'choose_account';
async function mustChoose(res: Response): Promise<boolean> {
  if (res.status !== 409) return false;
  const body = (await res.clone().json().catch(() => null)) as { error?: unknown } | null;
  return body?.error === CHOOSE_ACCOUNT_CODE;
}

async function isSessionExpiry(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const body = (await res.clone().json().catch(() => null)) as { error?: unknown } | null;
  return body?.error === SESSION_EXPIRED_CODE;
}

// fetch for cams's own API: same-origin credentials, and an expired session
// handled here (UnauthorizedError) instead of at every caller.
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (await isSessionExpiry(res)) {
    sessionExpired();
    throw new UnauthorizedError(url);
  }
  if (res.status === 409 && (await mustChoose(res))) {
    if (!leaving && !location.pathname.startsWith('/app/accounts')) {
      leaving = true;
      location.assign('/app/accounts');
    }
    throw new UnauthorizedError(url);
  }
  return res;
}

// For what can't see a status (an <img>, a <video>, EventSource): a failure
// asks /api/me whether the session is still there, at most every 30 s.
let probedAt = -Infinity;
export function checkSession(now = Date.now()): void {
  if (leaving || now - probedAt < PROBE_GAP_MS) return;
  probedAt = now;
  void apiFetch('/api/me', { headers: { Accept: 'application/json' } }).catch(() => undefined);
}

// One capturing listener for every failed image or video from /api (error
// events don't bubble, but they are captured).
export function watchMediaErrors(target: Document = document): () => void {
  const onError = (e: Event) => {
    const el = e.target as Element | null;
    if (!el || !['IMG', 'VIDEO', 'SOURCE'].includes(el.tagName)) return;
    const src = (el as HTMLImageElement).currentSrc || el.getAttribute('src') || '';
    if (src.startsWith('blob:')) return;
    try {
      const u = new URL(src, location.href);
      if (u.origin === location.origin && u.pathname.startsWith('/api/')) checkSession();
    } catch {
      // not a URL: not ours
    }
  };
  target.addEventListener('error', onError, true);
  return () => target.removeEventListener('error', onError, true);
}

// Tests only: a fresh page load.
export function resetSessionState(): void {
  leaving = false;
  probedAt = -Infinity;
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await apiFetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new HttpError(url, res.status, typeof body?.error === 'string' ? body.error : null);
  }
  return (await res.json()) as T;
}
