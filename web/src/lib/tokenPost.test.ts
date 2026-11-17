import { describe, expect, it, vi } from 'vitest';
import { postToken } from './tokenPost';

describe('postToken', () => {
  it('POSTs the token as JSON to the path, same-origin, never in the URL', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const res = await postToken('/auth/token', 'secret-token', fetchFn);
    expect(res.status).toBe(204);
    expect(fetchFn).toHaveBeenCalledWith('/auth/token', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: 'secret-token' }),
    });
  });
});
