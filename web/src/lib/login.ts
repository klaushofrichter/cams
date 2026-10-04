// The start page's sign-in options and the token login's request (spec
// 2026-10-04-pi-deployment-design).

export type LoginMethod = 'google' | 'token';

// From <meta name="cams-login" content="google token">, which the server
// fills in. Missing (the Vite dev server) or empty: Google, as before.
export function loginMethods(doc: Pick<Document, 'querySelector'> = document): LoginMethod[] {
  const content = doc.querySelector<HTMLMetaElement>('meta[name="cams-login"]')?.content ?? '';
  const methods = content.split(/\s+/).filter((m): m is LoginMethod => m === 'google' || m === 'token');
  return methods.length > 0 ? [...new Set(methods)] : ['google'];
}

export function loginErrorMessage(status: number): string {
  if (status === 401) return 'That token is not right.';
  if (status === 429) return 'Too many attempts. Try again later.';
  return 'Sign-in failed. Try again.';
}

// POST /auth/token with JSON (never the token in a URL). The server answers
// {redirect} with the session cookie set, or an error status.
export async function signInWithToken(token: string, fetchFn: typeof fetch = fetch): Promise<{ redirect: string } | { error: string }> {
  try {
    const res = await fetchFn('/auth/token', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { redirect?: unknown } | null;
      const redirect = typeof body?.redirect === 'string' && body.redirect.startsWith('/') && !body.redirect.startsWith('//') ? body.redirect : '/app/video';
      return { redirect };
    }
    return { error: loginErrorMessage(res.status) };
  } catch {
    return { error: loginErrorMessage(0) };
  }
}
