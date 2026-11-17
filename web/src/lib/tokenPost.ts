// The pre-auth token sign-in request, for the Pi's token login (/auth/token)
// and cams-admin's viewer tokens (/auth/viewer-token, its /check): JSON in
// the body, never the token in a URL. Not requestJson: there is no session
// yet, so apiFetch's signed-out handling does not apply.
export function postToken(path: string, token: string, fetchFn: typeof fetch = fetch): Promise<Response> {
  return fetchFn(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ token }),
  });
}

// Both sign-ins' words for a 429.
export const TOO_MANY_ATTEMPTS = 'Too many attempts. Try again later.';
