// The e2e cameras: three cam-sim processes (github.com/klaushofrichter/cam-sim)
// started by playwright.config.ts. e2e/cameras.json points Den, Porch and
// Shed at their HTTP ports. Credentials and the control token are test-only.
import type { Page } from '@playwright/test';

export const CONTROL_TOKEN = 'e2e-control-token-not-a-secret';

type Sim = { http: number; https: number; control: number; onvif: number; rtsp: number; faults: object[] };

const STRICT = { name: 'settings.strictPartial' }; // the old mock's behaviour

export const SIMS: Record<'den' | 'porch' | 'shed', Sim> = {
  den: { http: 8098, https: 8198, control: 8298, onvif: 8398, rtsp: 8498, faults: [STRICT] },
  // Porch always rejects SetWhiteLed, so settings.spec.ts can exercise a
  // partial save without making Den unreliable for the live specs.
  porch: { http: 8097, https: 8197, control: 8297, onvif: 8397, rtsp: 8497, faults: [STRICT, { name: 'settings.fail', cmds: ['SetWhiteLed'] }] },
  // Shed refuses every recording download, like the real RLC-1224A since
  // 2026-09-26 (Plan 5 breaker and banner).
  shed: { http: 8096, https: 8196, control: 8296, onvif: 8396, rtsp: 8496, faults: [STRICT, { name: 'downloads.refuse' }] },
};

export function simEnv(s: Sim): Record<string, string> {
  return {
    CAMSIM_USERS: 'e2e:admin:e2e-not-a-real-password',
    CAMSIM_CONTROL_TOKEN: CONTROL_TOKEN,
    CAMSIM_NAME: 'Den', // the old mock's on-screen name, for every camera
    CAMSIM_FIRMWARE: 'v3.2.0.6011_mock',
    CAMSIM_SEED_CLIPS: 'demo',
    CAMSIM_SD_MB: '61047', // the real camera's 64 GB card
    CAMSIM_HTTP_PORT: String(s.http),
    CAMSIM_HTTPS_PORT: String(s.https),
    CAMSIM_CONTROL_PORT: String(s.control),
    // Newer cam-sim versions also serve ONVIF and RTSP; three simulators on
    // one machine need their own ports.
    CAMSIM_ONVIF_PORT: String(s.onvif),
    CAMSIM_RTSP_PORT: String(s.rtsp),
    CAMSIM_FAULTS: JSON.stringify(s.faults),
    CAMSIM_LOG_LEVEL: 'warn',
  };
}

// A simulator's counters (the old mock's /__state), from its control API.
export async function simCounters(page: Page, cam: keyof typeof SIMS): Promise<Record<string, number>> {
  const res = await page.request.get(`http://127.0.0.1:${SIMS[cam].control}/sim/api/state`, {
    headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  return (await res.json()).counters;
}
