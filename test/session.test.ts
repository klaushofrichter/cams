import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { signSession, verifySession } from '../server/session';

// Review focus 4 (Plan 5): only HS256 tokens signed with our secret count.
describe('session tokens', () => {
  const secret = process.env.COOKIE_SECRET!;

  it('accepts its own tokens', () => {
    expect(verifySession(signSession('klaus@klaushofrichter.net'))).toEqual({ email: 'klaus@klaushofrichter.net' });
  });

  it('signs with HS256', () => {
    expect(jwt.decode(signSession('a@b.c'), { complete: true })?.header.alg).toBe('HS256');
  });

  it('rejects a token signed with another algorithm, even with the same secret', () => {
    expect(verifySession(jwt.sign({ email: 'klaus@klaushofrichter.net' }, secret, { algorithm: 'HS512' }))).toBeNull();
  });

  it('rejects an unsigned token', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ email: 'klaus@klaushofrichter.net', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    expect(verifySession(`${header}.${body}.`)).toBeNull();
  });
});
