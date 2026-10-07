// The fleet: every account this cams instance serves, with its users and
// cameras (migration P4, M §9.5, §9.6). Camera ids (camsIds) are unique only
// within an account, so inside cams every camera is a CamKey,
// `<accountId>/<camsId>` (ruling R4-8): every map, event, store entry and
// cache name uses it, and a bare camsId never finds a camera.
//
// File mode (CONFIG_SOURCE=file, the default) is one account, the file
// account, named CAMS_FILE_ACCOUNT (default "home"), with users = null
// (ALLOWED_EMAILS decides, everyone admin) — exactly as before P4.
import { EventEmitter } from 'events';
import type { CameraConfig } from './cameraRegistry';

export type CamKey = string & { readonly __camKey: unique symbol };
export type Role = 'admin' | 'viewer';
export interface AccountRef { id: string; name: string; displayName: string }
export interface FleetUser { email: string; role: Role; disabled: boolean }
export interface FleetAccount extends AccountRef {
  users: FleetUser[] | null; // null: file mode, ALLOWED_EMAILS and everyone admin
  cameras: CameraConfig[];
}

export const ACCOUNT_ID_RE = /^acc_[A-Za-z0-9]{1,40}$/;
// The camsId rule of cameras.json (server/cameraRegistry.ts ID_PATTERN).
export const CAMS_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function camKey(accountId: string, camsId: string): CamKey {
  if (typeof accountId !== 'string' || !ACCOUNT_ID_RE.test(accountId)) throw new Error('camKey: bad account id');
  if (typeof camsId !== 'string' || !CAMS_ID_RE.test(camsId)) throw new Error('camKey: bad camera id');
  return `${accountId}/${camsId}` as CamKey;
}

export function parseKey(k: string): { accountId: string; camsId: string } | null {
  if (typeof k !== 'string') return null;
  const i = k.indexOf('/');
  if (i < 0) return null;
  const accountId = k.slice(0, i), camsId = k.slice(i + 1);
  if (!ACCOUNT_ID_RE.test(accountId) || !CAMS_ID_RE.test(camsId)) return null;
  return { accountId, camsId };
}

export const camsIdOf = (k: CamKey): string => k.slice(k.indexOf('/') + 1);
export const accountIdOf = (k: CamKey): string => k.slice(0, k.indexOf('/'));
// For flat names (the clip cache, ruling R4-15): "acc_X.cam1", no slash.
export const fileSafe = (k: CamKey): string => `${accountIdOf(k)}.${camsIdOf(k)}`;

// The file account's id until a verified cams-admin cache names the real one
// (setFileAccountId, Task 8). Stores find their entries by id, else by name.
export const DEFAULT_FILE_ACCOUNT_ID = 'acc_file';
let fileAccountId = DEFAULT_FILE_ACCOUNT_ID;

export function fileAccount(): AccountRef {
  const name = process.env.CAMS_FILE_ACCOUNT || 'home';
  return { id: fileAccountId, name, displayName: name === 'home' ? 'Home' : name };
}

export function setFileAccountId(id: string): void {
  if (!ACCOUNT_ID_RE.test(id)) throw new Error('setFileAccountId: bad account id');
  fileAccountId = id;
}

// 'applied' { accountIds }: a new fleet is in use (the relay tells the
// browsers of those accounts to re-read their camera list).
export const fleetEvents = new EventEmitter();
fleetEvents.setMaxListeners(0);

let accounts: readonly FleetAccount[] = [];
let cameras: readonly CameraConfig[] = [];
let byKey = new Map<CamKey, CameraConfig>();

// Replaces everything. The camera list is one new array per fleet (the
// proxy groups memoize on its identity).
export function setFleet(list: FleetAccount[]): void {
  accounts = list.map((a) => ({ ...a, cameras: [...a.cameras] }));
  cameras = accounts.flatMap((a) => a.cameras);
  byKey = new Map(cameras.map((c) => [c.id, c]));
  fleetEvents.emit('applied', { accountIds: accounts.map((a) => a.id) });
}

export const fleetAccounts = (): readonly FleetAccount[] => accounts;
export const fleetAccount = (id: string): FleetAccount | undefined => accounts.find((a) => a.id === id);
export const fleetAccountByName = (name: string): FleetAccount | undefined => accounts.find((a) => a.name === name);
// Every camera of every account (internal: groups, TLS loading).
export const fleetCameras = (): readonly CameraConfig[] => cameras;
export const fleetCamera = (key: CamKey): CameraConfig | undefined => byKey.get(key);
