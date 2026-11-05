// The /token page's helpers (cams-admin design 2026-11-05-viewer-tokens-design
// §9.2): what counts as a token in a pasted text, a scanned QR code or the
// link's fragment, and the two requests. The token goes to the server in a
// JSON body only, never in a URL.

export const VIEWER_TOKEN_RE = /^cav_[0-9A-Za-z]{22}$/;

// The link's fragment, "#t=<token>" (also "t=<token>"): the token, or null.
export function tokenFromFragment(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const t = new URLSearchParams(hash.replace(/^#/, '')).get('t');
  return t !== null && VIEWER_TOKEN_RE.test(t) ? t : null;
}

// A sign-in link "<origin>/token#t=<token>" (no query): its origin and token.
function linkToken(text: string): { origin: string; token: string } | null {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.pathname !== '/token' || u.search !== '') return null;
  const token = tokenFromFragment(u.hash);
  return token ? { origin: u.origin, token } : null;
}

// A scanned QR code: a bare token, or this viewer's own sign-in link (a code
// pointing anywhere else is not followed or read).
export function tokenFromScan(text: string, origin: string): string | null {
  const s = text.trim();
  if (VIEWER_TOKEN_RE.test(s)) return s;
  const l = linkToken(s);
  return l && l.origin === origin ? l.token : null;
}

// A pasted text: the token (white space around it trimmed, the case kept:
// base62), or a sign-in link copied from cams-admin (any viewer's: the
// person pasted it here on purpose; only the token is sent, to this viewer).
export function tokenFromPaste(text: string): string | null {
  const s = text.trim();
  if (VIEWER_TOKEN_RE.test(s)) return s;
  return linkToken(s)?.token ?? null;
}

export function viewerTokenError(status: number): string {
  if (status === 401) return 'This token doesn\'t work here: it may have expired or been revoked.';
  if (status === 429) return 'Too many attempts. Try again later.';
  return 'Sign-in failed. Try again.';
}

async function postToken(path: string, token: string, fetchFn: typeof fetch): Promise<Response> {
  return fetchFn(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ token }),
  });
}

// The token's name and expiry (the link's confirm step), or an error to show.
export async function checkViewerToken(token: string, fetchFn: typeof fetch = fetch): Promise<{ name: string; expiresAt: number } | { error: string }> {
  try {
    const res = await postToken('/auth/viewer-token/check', token, fetchFn);
    if (!res.ok) return { error: viewerTokenError(res.status) };
    const body = (await res.json().catch(() => null)) as { name?: unknown; expiresAt?: unknown } | null;
    if (typeof body?.name !== 'string' || typeof body.expiresAt !== 'number') return { error: viewerTokenError(0) };
    return { name: body.name, expiresAt: body.expiresAt };
  } catch {
    return { error: viewerTokenError(0) };
  }
}

// Signs in: where to go next (the cookie is set), or an error to show.
export async function signInWithViewerToken(token: string, fetchFn: typeof fetch = fetch): Promise<{ redirect: string } | { error: string }> {
  try {
    const res = await postToken('/auth/viewer-token', token, fetchFn);
    if (!res.ok) return { error: viewerTokenError(res.status) };
    const body = (await res.json().catch(() => null)) as { redirect?: unknown } | null;
    const r = body?.redirect;
    return { redirect: typeof r === 'string' && /^\/app(?:[/?#]|$)/.test(r) && !r.includes('//') ? r : '/app/video' };
  } catch {
    return { error: viewerTokenError(0) };
  }
}

// "valid until …" in the person's own words: date and time, local.
export function validUntilText(ms: number, locale?: string): string {
  return new Date(ms).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}
