// A token is its issuer, in its account, as they are now (spec §6 "Who").
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { principalIn } from '../../server/middleware/requireAuth';
import { bearerPrincipal } from '../../server/mcp/auth';
import { tokenFingerprint } from '../../server/loginConfig';
import { ALPHA, BETA, applyFleet, restoreMode, twoAccounts } from '../helpers/fleet';
import { freshTokens, issue } from './helpers';

beforeEach(() => {
  freshTokens();
  applyFleet(twoAccounts());
});
afterEach(() => {
  restoreMode();
  delete process.env.CAMS_LOGIN_TOKEN;
});

describe('principalIn', () => {
  it('is the member’s role in that account', () => {
    expect(principalIn({ email: 'both@example.org', via: 'google' }, ALPHA)).toMatchObject({ role: 'admin', account: { id: ALPHA } });
    expect(principalIn({ email: 'BOTH@example.org', via: 'google' }, BETA)).toMatchObject({ role: 'viewer', account: { id: BETA } });
    expect(principalIn({ email: 'alpha@example.org', via: 'google' }, BETA)).toBeNull();
  });

  it('is null for a disabled member', () => {
    const fleet = twoAccounts();
    fleet[0].users![0].disabled = true;
    applyFleet(fleet);
    expect(principalIn({ email: 'both@example.org', via: 'google' }, ALPHA)).toBeNull();
  });

  it('follows the token login for a token-login issuer', () => {
    applyFleet([twoAccounts()[0]]);
    process.env.CAMS_LOGIN_TOKEN = 't'.repeat(30);
    const tf = tokenFingerprint('t'.repeat(30));
    expect(principalIn({ email: 'local', via: 'token', tf }, ALPHA)).toMatchObject({ role: 'admin' });
    process.env.CAMS_LOGIN_TOKEN = 'u'.repeat(30);
    expect(principalIn({ email: 'local', via: 'token', tf }, ALPHA)).toBeNull();
  });
});

describe('bearerPrincipal', () => {
  it('gives the issuer as principal, marked as the token', () => {
    const { token, id } = issue(ALPHA, 'both@example.org');
    const b = bearerPrincipal(`Bearer ${token}`);
    expect(b?.principal).toMatchObject({ email: 'both@example.org', via: 'mcp', mcpTokenId: id, role: 'admin', account: { id: ALPHA } });
  });

  it('refuses a missing or malformed header and a removed issuer', () => {
    const { token } = issue(BETA, 'both@example.org');
    expect(bearerPrincipal(undefined)).toBeNull();
    expect(bearerPrincipal(token)).toBeNull();
    expect(bearerPrincipal(`Basic ${token}`)).toBeNull();
    expect(bearerPrincipal(`Bearer ${token}`)).not.toBeNull();
    applyFleet(twoAccounts({ betaRemoved: 'both@example.org' }));
    expect(bearerPrincipal(`Bearer ${token}`)).toBeNull();
  });
});
