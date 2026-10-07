// Two-account fixtures and camera keys for the multi-account tests
// (migration P4, M §9.6). ALPHA and BETA both have a camera "cam1", each on
// its own fake proxy (URL and token), so anything that crosses accounts shows.
import { camKey, fileAccount, type CamKey, type FleetAccount, type Role } from '../../server/fleet';
import { keyed, type FileCameraConfig } from '../../server/cameraRegistry';

export const k = (camsId: string): CamKey => camKey(fileAccount().id, camsId);
export const ALPHA = 'acc_ALPHAALPHAALPHAALPHA';
export const BETA = 'acc_BETABETABETABETABE';
export const ALPHA_REF = { id: ALPHA, name: 'alpha', displayName: 'Alpha' };
export const BETA_REF = { id: BETA, name: 'beta', displayName: 'Beta' };

export interface TwoAccountOptions {
  alphaUrl?: string;
  betaUrl?: string;
  alphaToken?: string;
  betaToken?: string;
  betaRole?: Role;
  betaRemoved?: string;
  alphaExtra?: FileCameraConfig[];
  betaExtra?: FileCameraConfig[];
  host?: string;
}

const cam = (id: string, name: string, url: string, token: string, host: string): FileCameraConfig => ({
  id, name, host, protocol: 'http', user: 'cams', password: 'pw', proxy: { url, token },
});

export function twoAccounts(o: TwoAccountOptions = {}): FleetAccount[] {
  const host = o.host ?? '127.0.0.1:9';
  const alpha: FleetAccount = {
    ...ALPHA_REF,
    users: [
      { email: 'both@example.org', role: 'admin', disabled: false },
      { email: 'alpha@example.org', role: 'admin', disabled: false },
    ],
    cameras: keyed(ALPHA, [cam('cam1', 'Alpha cam', o.alphaUrl ?? 'http://127.0.0.1:1/alpha', o.alphaToken ?? 'a'.repeat(40), host), ...(o.alphaExtra ?? [])]),
  };
  const betaUsers = [{ email: 'both@example.org', role: o.betaRole ?? ('viewer' as Role), disabled: false }].filter((u) => u.email !== o.betaRemoved);
  const beta: FleetAccount = {
    ...BETA_REF,
    users: betaUsers,
    cameras: keyed(BETA, [cam('cam1', 'Beta cam', o.betaUrl ?? 'http://127.0.0.1:1/beta', o.betaToken ?? 'b'.repeat(40), host), ...(o.betaExtra ?? [])]),
  };
  return [alpha, beta];
}
