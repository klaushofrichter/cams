// The /token page's parsing and requests (cams-admin design 2026-11-05 §9.2).
import { describe, expect, it, vi } from 'vitest';
import vectors from '../../../contract/cams-v1/vectors.json';
import { checkViewerToken, signInWithViewerToken, tokenFromFragment, tokenFromPaste, tokenFromScan } from './viewerToken';

const T = 'cav_WebTestFakeTokenNo0001';
const ORIGIN = 'https://cams.example.test';

describe('reading a token', () => {
  it('the contract vector\'s link: its fragment is the token', () => {
    const v = vectors.viewerTokens[0];
    expect(tokenFromFragment(new URL(v.link).hash)).toBe(v.token);
    expect(tokenFromPaste(v.link)).toBe(v.token);
    expect(tokenFromScan(v.link, 'https://cams.skylar.technology')).toBe(v.token);
  });

  it('the fragment: #t=<token> only', () => {
    expect(tokenFromFragment(`#t=${T}`)).toBe(T);
    for (const bad of ['', '#', `#token=${T}`, `#t=${T}x`, `#t=${T.toUpperCase()}`, null, undefined]) expect(tokenFromFragment(bad)).toBeNull();
  });

  it('a scan: a bare token, or this viewer\'s own link; another site\'s link, a query or another path: nothing', () => {
    expect(tokenFromScan(T, ORIGIN)).toBe(T);
    expect(tokenFromScan(` ${T}\n`, ORIGIN)).toBe(T);
    expect(tokenFromScan(`${ORIGIN}/token#t=${T}`, ORIGIN)).toBe(T);
    for (const bad of [`https://evil.example/token#t=${T}`, `${ORIGIN}/token?x=1#t=${T}`, `${ORIGIN}/signin#t=${T}`, `${ORIGIN}/token?t=${T}`, 'WIFI:S:x;;', `javascript:alert(1)//#t=${T}`]) expect(tokenFromScan(bad, ORIGIN)).toBeNull();
  });

  it('a paste: the token trimmed (case kept), or a sign-in link of any viewer', () => {
    expect(tokenFromPaste(`  ${T}  `)).toBe(T);
    expect(tokenFromPaste(`https://other.example/token#t=${T}`)).toBe(T);
    expect(tokenFromPaste(T.toUpperCase())).toBeNull();
    expect(tokenFromPaste(`${T.slice(0, 10)} ${T.slice(10)}`)).toBeNull();
    expect(tokenFromPaste(`ftp://x/token#t=${T}`)).toBeNull();
  });
});

describe('the requests', () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

  it('check: JSON body, never the token in the URL; name and expiry back', async () => {
    const f = answer(200, { name: 'Tablet', expiresAt: 5 });
    expect(await checkViewerToken(T, f as unknown as typeof fetch)).toEqual({ name: 'Tablet', expiresAt: 5 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/auth/viewer-token/check');
    expect(url).not.toContain(T);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ token: T }) });
  });

  it('errors in words; sign-in follows only an /app redirect', async () => {
    expect(await checkViewerToken(T, answer(401, { error: 'invalid_token' }) as unknown as typeof fetch)).toEqual({ error: expect.stringContaining('expired or been revoked') });
    expect(await signInWithViewerToken(T, answer(429, {}) as unknown as typeof fetch)).toEqual({ error: 'Too many attempts. Try again later.' });
    expect(await signInWithViewerToken(T, answer(200, { redirect: '/app/accounts' }) as unknown as typeof fetch)).toEqual({ redirect: '/app/accounts' });
    expect(await signInWithViewerToken(T, answer(200, { redirect: 'https://evil.example/app' }) as unknown as typeof fetch)).toEqual({ redirect: '/app/video' });
    expect(await signInWithViewerToken(T, vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toEqual({ error: 'Sign-in failed. Try again.' });
  });
});
