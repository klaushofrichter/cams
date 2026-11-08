// Viewer tokens, the cams side (cams-admin design
// docs/superpowers/specs/2026-11-05-viewer-tokens-design.md §9): the
// fingerprint against the contract's vector, the fleet's index of tokens
// joined across accounts, the checks (unknown, expired by cams-admin's
// clock, the 24 h offline rule, cams-admin mode only), the session lookup
// and the "last used" list for the report.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import vectors from '../contract/cams-v1/vectors.json';
import { setFleet, type FleetAccount } from '../server/fleet';
import { viewerTokenMemberships } from '../server/middleware/requireAuth';
import {
  checkViewerToken, noteViewerTokenUse, returnViewerTokenUses, sessionTag, setViewerTokenClock, takeViewerTokenUses,
  viewerTokenFingerprint, viewerTokenForSession, viewerTokenLink, viewerTokens, VIEWER_TOKEN_RE, type ViewerTokenGrant,
} from '../server/viewerTokens';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const T1 = 'cav_UnitTestFakeTokenNo001';
const T2 = 'cav_UnitTestFakeTokenNo002';
const T3 = 'cav_UnitTestFakeTokenNo003';
const ID1 = 'vtk_00000000000000000001';
const ID2 = 'vtk_00000000000000000002';
const ID3 = 'vtk_00000000000000000003';
const grant = (id: string, token: string, expiresAt = NOW + 7 * 24 * HOUR, name = `name ${id.slice(-1)}`): ViewerTokenGrant => ({ id, name, fingerprint: viewerTokenFingerprint(token), expiresAt });
const acc = (id: string, name: string, viewerTokens: ReturnType<typeof grant>[]): FleetAccount => ({ id, name, displayName: name.toUpperCase(), users: [], cameras: [], viewerTokens });
const ALPHA = 'acc_ALPHAALPHAALPHAALPHA';
const BETA = 'acc_BETABETABETABETABE';

let clock: { now: number; adminNow: number; lastGoodAt: number | null; enabled: boolean };
beforeEach(() => {
  clock = { now: NOW, adminNow: NOW, lastGoodAt: NOW - 60_000, enabled: true };
  setViewerTokenClock({ now: () => clock.now, adminNow: () => clock.adminNow, lastGoodAt: () => clock.lastGoodAt, enabled: () => clock.enabled });
  setFleet([
    acc(ALPHA, 'alpha', [grant(ID1, T1), grant(ID2, T2, NOW + HOUR)]),
    acc(BETA, 'beta', [grant(ID2, T2, NOW + 2 * HOUR), grant(ID3, T3, NOW - 1)]),
  ]);
  takeViewerTokenUses();
});
afterEach(() => {
  setViewerTokenClock(null);
  setFleet([]);
});

describe('the token and its fingerprint (contract vectors)', () => {
  it('reproduces vectors.json viewerTokens: the fingerprint and the link', () => {
    for (const v of vectors.viewerTokens) {
      expect(VIEWER_TOKEN_RE.test(v.token)).toBe(true);
      expect(viewerTokenFingerprint(v.token)).toBe(v.fingerprint);
      expect(viewerTokenLink('https://cams.skylar.technology', v.token)).toBe(v.link);
    }
  });

  it('the token format: cav_ and 22 base62 characters, case kept', () => {
    expect(VIEWER_TOKEN_RE.test(T1)).toBe(true);
    for (const bad of ['', 'cav_short', `${T1}x`, T1.toUpperCase(), `cao_${T1.slice(4)}`, `cav_${'-'.repeat(22)}`, ` ${T1}`]) expect(VIEWER_TOKEN_RE.test(bad)).toBe(false);
  });

  it('the session tag is 16 hex of the fingerprint', () => {
    expect(sessionTag(viewerTokenFingerprint(T1))).toMatch(/^[0-9a-f]{16}$/);
    expect(sessionTag(viewerTokenFingerprint(T1))).toBe(viewerTokenFingerprint(T1).slice(7, 23));
  });
});

describe('the fleet index', () => {
  it('joins a token across its accounts by id, with the earlier expiry', () => {
    const t = viewerTokens().byId.get(ID2)!;
    expect(t.accounts.map((a) => a.id)).toEqual([ALPHA, BETA]);
    expect(t.expiresAt).toBe(NOW + HOUR);
    expect(viewerTokens().byFingerprint.get(viewerTokenFingerprint(T2))?.id).toBe(ID2);
  });

  it('an id listed with two different fingerprints is dropped', () => {
    setFleet([acc(ALPHA, 'alpha', [grant(ID1, T1)]), acc(BETA, 'beta', [grant(ID1, T2)])]);
    expect(viewerTokens().byId.has(ID1)).toBe(false);
    expect(checkViewerToken(T1)).toEqual({ ok: false, reason: 'unknown' });
    expect(checkViewerToken(T2)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('a fingerprint listed under two ids is dropped', () => {
    setFleet([acc(ALPHA, 'alpha', [grant(ID1, T1), grant(ID2, T1)])]);
    expect(checkViewerToken(T1)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('a new fleet without the token: gone (a revoke)', () => {
    expect(checkViewerToken(T1).ok).toBe(true);
    setFleet([acc(ALPHA, 'alpha', [])]);
    expect(checkViewerToken(T1)).toEqual({ ok: false, reason: 'unknown' });
  });
});

// Spec A4: an admin token is an admin of the accounts whose entry says so.
describe('the role per account', () => {
  it('admin where the account lists it as admin, viewer elsewhere and by default', () => {
    setFleet([
      acc(ALPHA, 'alpha', [{ ...grant(ID1, T1), role: 'admin' }, grant(ID2, T2)]),
      acc(BETA, 'beta', [grant(ID1, T1)]),
    ]);
    expect(viewerTokenMemberships(viewerTokens().byId.get(ID1)!).map((m) => [m.account.id, m.role])).toEqual([[ALPHA, 'admin'], [BETA, 'viewer']]);
    expect(viewerTokenMemberships(viewerTokens().byId.get(ID2)!).map((m) => [m.account.id, m.role])).toEqual([[ALPHA, 'viewer']]);
  });
});

describe('checkViewerToken (a token presented at sign-in)', () => {
  it('a listed, valid token: its id, name, expiry and accounts', () => {
    const r = checkViewerToken(T1);
    expect(r).toMatchObject({ ok: true, token: { id: ID1, name: 'name 1', expiresAt: NOW + 7 * 24 * HOUR } });
    if (r.ok) expect(r.token.accounts).toEqual([{ id: ALPHA, name: 'alpha', displayName: 'ALPHA' }]);
  });

  it('not a token, an unknown one, an expired one: refused, each with its reason (one answer to the client)', () => {
    expect(checkViewerToken(undefined)).toEqual({ ok: false, reason: 'format' });
    expect(checkViewerToken(42)).toEqual({ ok: false, reason: 'format' });
    expect(checkViewerToken(`${T1} `)).toEqual({ ok: false, reason: 'format' });
    expect(checkViewerToken('cav_UnitTestFakeTokenNo999')).toEqual({ ok: false, reason: 'unknown' });
    expect(checkViewerToken(T3)).toEqual({ ok: false, reason: 'expired' });
  });

  it('expiry is judged by cams-admin\'s clock (the measured offset), not only the local one', () => {
    clock.adminNow = NOW + HOUR; // the local clock is an hour behind cams-admin
    expect(checkViewerToken(T2)).toEqual({ ok: false, reason: 'expired' });
    clock.adminNow = NOW + HOUR - 1;
    expect(checkViewerToken(T2).ok).toBe(true);
  });

  it('the 24 h rule: refused once the last good pull is more than 24 h old, or there never was one', () => {
    clock.lastGoodAt = NOW - 24 * HOUR;
    expect(checkViewerToken(T1).ok).toBe(true);
    clock.lastGoodAt = NOW - 24 * HOUR - 1;
    expect(checkViewerToken(T1)).toEqual({ ok: false, reason: 'offline' });
    clock.lastGoodAt = null;
    expect(checkViewerToken(T1)).toEqual({ ok: false, reason: 'offline' });
  });

  it('outside cams-admin mode: off', () => {
    clock.enabled = false;
    expect(checkViewerToken(T1)).toEqual({ ok: false, reason: 'off' });
  });
});

describe('viewerTokenForSession (every request of a session)', () => {
  const tag1 = () => sessionTag(viewerTokenFingerprint(T1));
  it('the token by id while its fingerprint tag matches', () => {
    expect(viewerTokenForSession(ID1, tag1())?.id).toBe(ID1);
    expect(viewerTokenForSession(ID1, sessionTag(viewerTokenFingerprint(T2)))).toBeNull();
    expect(viewerTokenForSession('vtk_00000000000000000009', tag1())).toBeNull();
  });

  it('ends with a revoke, a shorter validity, the expiry, 24 h offline and outside cams-admin mode', () => {
    expect(viewerTokenForSession(ID1, tag1())).not.toBeNull();
    setFleet([acc(ALPHA, 'alpha', [grant(ID1, T1, NOW + 1000)])]); // shortened
    expect(viewerTokenForSession(ID1, tag1())).not.toBeNull();
    clock.adminNow = NOW + 1000;
    expect(viewerTokenForSession(ID1, tag1())).toBeNull();
    clock.adminNow = NOW;
    clock.lastGoodAt = NOW - 25 * HOUR;
    expect(viewerTokenForSession(ID1, tag1())).toBeNull();
    clock.lastGoodAt = NOW;
    clock.enabled = false;
    expect(viewerTokenForSession(ID1, tag1())).toBeNull();
    clock.enabled = true;
    setFleet([acc(ALPHA, 'alpha', [])]); // revoked
    expect(viewerTokenForSession(ID1, tag1())).toBeNull();
  });
});

describe('last used (the report\'s viewerTokens)', () => {
  it('per token the newest use, rounded down to the minute; taken once', () => {
    clock.adminNow = NOW + 59_999;
    expect(noteViewerTokenUse(ID1)).toBe(true); // the first since the last report
    clock.adminNow = NOW + 130_000;
    expect(noteViewerTokenUse(ID1)).toBe(false);
    noteViewerTokenUse(ID2);
    const minute = (t: number) => Math.floor(t / 60_000) * 60_000;
    expect(takeViewerTokenUses()).toEqual([{ id: ID1, lastUsedAt: minute(NOW + 130_000) }, { id: ID2, lastUsedAt: minute(NOW + 130_000) }]);
    expect(takeViewerTokenUses()).toEqual([]);
  });

  it('at most 200 a report, the newest first; the rest wait for the next one', () => {
    for (let i = 0; i < 250; i++) {
      clock.adminNow = NOW + i * 60_000;
      noteViewerTokenUse(`vtk_${String(i).padStart(20, '0')}`);
    }
    const first = takeViewerTokenUses();
    expect(first).toHaveLength(200);
    expect(first[0].id).toBe(`vtk_${String(249).padStart(20, '0')}`);
    expect(takeViewerTokenUses()).toHaveLength(50);
  });

  it('a report that was not sent gives its list back (a newer use wins)', () => {
    noteViewerTokenUse(ID1);
    const list = takeViewerTokenUses();
    clock.adminNow = NOW + 5 * 60_000;
    noteViewerTokenUse(ID1);
    returnViewerTokenUses(list);
    expect(takeViewerTokenUses()).toEqual([{ id: ID1, lastUsedAt: NOW + 5 * 60_000 }]);
  });
});
