export class UnauthorizedError extends Error {}

// Session gone (expired, or the allow-list changed): back to the landing page.
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (res.status === 401) {
    location.assign('/');
    throw new UnauthorizedError(url);
  }
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return (await res.json()) as T;
}
