import { describe, expect, it, vi } from 'vitest';
import { loginErrorMessage, loginMethods, signInWithToken } from './login';

const doc = (content: string | null) => ({
  querySelector: () => (content === null ? null : { content }),
}) as unknown as Pick<Document, 'querySelector'>;

describe('loginMethods', () => {
  it('reads the meta tag', () => {
    expect(loginMethods(doc('google'))).toEqual(['google']);
    expect(loginMethods(doc('token'))).toEqual(['token']);
    expect(loginMethods(doc('google token'))).toEqual(['google', 'token']);
  });
  it('falls back to Google without a usable tag', () => {
    expect(loginMethods(doc(null))).toEqual(['google']);
    expect(loginMethods(doc(''))).toEqual(['google']);
    expect(loginMethods(doc('other'))).toEqual(['google']);
  });
});

describe('signInWithToken', () => {
  it('only follows a same-site path', async () => {
    const ok = (redirect: unknown) => vi.fn(async () => new Response(JSON.stringify({ redirect }), { status: 200 })) as unknown as typeof fetch;
    expect(await signInWithToken('t', ok('/app/live'))).toEqual({ redirect: '/app/live' });
    expect(await signInWithToken('t', ok('//evil.example'))).toEqual({ redirect: '/app/video' });
    expect(await signInWithToken('t', ok('https://evil.example'))).toEqual({ redirect: '/app/video' });
  });
  it('maps errors to messages', async () => {
    expect(await signInWithToken('t', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toEqual({ error: loginErrorMessage(0) });
    expect(loginErrorMessage(500)).toBe('Sign-in failed. Try again.');
  });
});

describe('cams-admin mode without a configuration (migration P4)', () => {
  it('reads <meta name="cams-config" content="none">', async () => {
    const { noConfiguration } = await import('./login');
    const doc = (content: string | null) => ({ querySelector: () => (content === null ? null : ({ content } as HTMLMetaElement)) }) as unknown as Pick<Document, 'querySelector'>;
    expect(noConfiguration(doc('none'))).toBe(true);
    expect(noConfiguration(doc(null))).toBe(false);
    expect(noConfiguration(doc(''))).toBe(false);
  });
  it('a token sign-in without an account says so', async () => {
    const { loginErrorMessage } = await import('./login');
    expect(loginErrorMessage(503)).toMatch(/no account/i);
  });
});
