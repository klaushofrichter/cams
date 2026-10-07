// Who may use which account (migration P4, M §9.5). File and shadow mode:
// one account, everyone in ALLOWED_EMAILS is its admin (as before). cams-admin
// mode: the applied configuration's users (not disabled), email compared in
// lower case; one user per account, role admin or viewer.
import { getAllowedEmails } from './allowedEmails';
import { configMode } from './configSource';
import { fileAccount, fleetAccountByName, fleetAccounts, type AccountRef, type Role } from './fleet';

export interface Membership { account: AccountRef; role: Role }
export const REMEMBER_COOKIE = 'cams_account';

const refOf = (a: AccountRef): AccountRef => ({ id: a.id, name: a.name, displayName: a.displayName });

export function membershipsOf(email: string): Membership[] {
  if (configMode() !== 'cams-admin') return getAllowedEmails().includes(email) ? [{ account: fileAccount(), role: 'admin' }] : [];
  const want = email.toLowerCase();
  const out: Membership[] = [];
  for (const a of fleetAccounts()) {
    const u = a.users?.find((x) => x.email.toLowerCase() === want && !x.disabled);
    if (u) out.push({ account: refOf(a), role: u.role });
  }
  return out.sort((x, y) => (x.account.name < y.account.name ? -1 : x.account.name > y.account.name ? 1 : 0));
}

// The token sign-in's account (R4-14): CAMS_TOKEN_ACCOUNT (an account name),
// else the only served account. Never a guess between several.
export function tokenAccount(): { ok: true; account: AccountRef } | { ok: false; reason: 'ambiguous' | 'unknown' | 'none' } {
  if (configMode() !== 'cams-admin') return { ok: true, account: fileAccount() };
  const name = process.env.CAMS_TOKEN_ACCOUNT;
  if (name) {
    const a = fleetAccountByName(name);
    return a ? { ok: true, account: refOf(a) } : { ok: false, reason: 'unknown' };
  }
  const all = fleetAccounts();
  if (all.length === 1) return { ok: true, account: refOf(all[0]) };
  return { ok: false, reason: all.length ? 'ambiguous' : 'none' };
}
