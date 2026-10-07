// The two layouts of cams's state files (migration P4, M §11.5, R4-10):
// the old one (today's: one account, the file account) and the account
// layout `{ v: 2, accounts: { <accountId>: { name, data } } }`. The first
// start in cams-admin mode moves a file into the account layout (a
// `.pre-accounts.bak` copy kept); file mode reads either, finding the file
// account's entry by id or else by name, so a rollback keeps what users
// changed in cams-admin mode.
import { promises as fs } from 'fs';
import { fileAccount, fleetAccount, type AccountRef } from './fleet';

export interface AccountLayout<T> { v: 2; accounts: Record<string, { name: string; data: T }> }
export type Loaded<T> = { layout: 'old'; data: T } | { layout: 'accounts'; file: AccountLayout<T> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// A parsed file in the account layout (v: 2 and an accounts object whose
// entries have a name and a data value), or null when it isn't one.
export function asAccountLayout<T>(parsed: unknown, dataOk: (d: unknown) => d is T): AccountLayout<T> | null {
  if (!isObject(parsed) || parsed.v !== 2 || !isObject(parsed.accounts)) return null;
  const accounts: AccountLayout<T>['accounts'] = {};
  for (const [id, e] of Object.entries(parsed.accounts)) {
    if (!isObject(e) || typeof e.name !== 'string' || !dataOk(e.data)) return null;
    accounts[id] = { name: e.name, data: e.data };
  }
  return { v: 2, accounts };
}

// Whether a parsed file claims the account layout (v: 2), valid or not.
export const claimsAccountLayout = (parsed: unknown): boolean => isObject(parsed) && parsed.v === 2;

// By id; by name only for the file account (its id may be named later, R4-10):
// another account never reads a same-named entry (a renamed or reused name).
export function entryFor<T>(l: AccountLayout<T>, account: AccountRef): T | undefined {
  if (Object.prototype.hasOwnProperty.call(l.accounts, account.id)) return l.accounts[account.id].data;
  if (!isFileAccount(account)) return undefined;
  return Object.values(l.accounts).find((e) => e.name === account.name)?.data;
}

// A copy with the account's entry set; an entry found by name only is
// re-keyed to the account's id.
export function withEntry<T>(l: AccountLayout<T>, account: AccountRef, data: T): AccountLayout<T> {
  const accounts: AccountLayout<T>['accounts'] = {};
  const byName = isFileAccount(account);
  for (const [id, e] of Object.entries(l.accounts)) if (id !== account.id && !(byName && e.name === account.name)) accounts[id] = e;
  accounts[account.id] = { name: account.name, data };
  return { v: 2, accounts: Object.fromEntries(Object.entries(accounts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
}

export function toAccounts<T>(old: T, account: AccountRef): AccountLayout<T> {
  return { v: 2, accounts: { [account.id]: { name: account.name, data: old } } };
}

// The old layout's data belongs to the file account (by id, or by name).
export const isFileAccount = (account: AccountRef): boolean => account.id === fileAccount().id || account.name === fileAccount().name;

// The account for an id, as far as cams knows it (the fleet, or the file account).
export function accountRefOf(accountId: string): AccountRef {
  if (accountId === fileAccount().id) return fileAccount();
  return fleetAccount(accountId) ?? { id: accountId, name: '', displayName: '' };
}

// Copies the file to `${file}.pre-accounts.bak` unless that exists (the
// first copy is the one before the move); the mode is kept.
export async function backupOnce(file: string): Promise<void> {
  const bak = `${file}.pre-accounts.bak`;
  try {
    await fs.access(bak);
    return;
  } catch {
    // none yet
  }
  const st = await fs.stat(file);
  await fs.copyFile(file, bak);
  await fs.chmod(bak, st.mode & 0o777);
}
