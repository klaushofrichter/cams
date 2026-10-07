// The session's account and role in the web app (migration P4, M §9.5):
// what the menu, the banners and the admin-only controls read, and the
// account switch (a full page load afterwards: nothing of the old account
// survives in memory, and its camera state in sessionStorage is cleared).
import { apiFetch, HttpError } from './api';
import type { Me } from './stores';

// An older server (or file mode) has no role: everyone is admin there.
export const isAdmin = (me: Me | null | undefined): boolean => !!me && (me.role === undefined || me.role === null ? true : me.role === 'admin');

// The camera state pages keep per tab (lib/recordings.ts, lib/timeline.ts).
export const CAMERA_SESSION_KEYS = ['cams-cursor', 'cams.viewPoint'] as const;

export function clearCameraSessionState(): void {
  for (const k of CAMERA_SESSION_KEYS) {
    try {
      sessionStorage.removeItem(k);
    } catch {
      // storage blocked: nothing kept either
    }
  }
}

export interface AccountItem { id: string; name: string; displayName: string; role: 'admin' | 'viewer'; current: boolean; remembered: boolean }

export async function switchAccount(accountId: string): Promise<void> {
  const res = await apiFetch('/api/session/account', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ accountId }) });
  const body = (await res.json().catch(() => null)) as { redirect?: unknown; error?: unknown } | null;
  if (!res.ok) throw new HttpError('/api/session/account', res.status, typeof body?.error === 'string' ? body.error : null);
  clearCameraSessionState();
  location.assign(typeof body?.redirect === 'string' && body.redirect.startsWith('/app') ? body.redirect : '/app/video');
}

// Whether to show controls that change cameras, the proxy switch or the
// archive. Unknown (no /api/me answer) shows them as before: the server's
// access table (server/routes/access.ts) is what enforces the role.
export const showsAdminControls = (me: Me | null | undefined): boolean => me === null || me === undefined || isAdmin(me);
