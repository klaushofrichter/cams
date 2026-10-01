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

// Session gone (expired, or the allow-list changed): back to the landing page.
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (res.status === 401) {
    location.assign('/');
    throw new UnauthorizedError(url);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new HttpError(url, res.status, typeof body?.error === 'string' ? body.error : null);
  }
  return (await res.json()) as T;
}
