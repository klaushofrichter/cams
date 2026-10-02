// The e2e cameras: five cam-sim processes (github.com/klaushofrichter/cam-sim)
// started by playwright.config.ts. e2e/cameras.json points Den, Porch, Shed,
// Barn and Silo at their HTTP ports. Credentials and the control token are test-only.
import type { Page } from '@playwright/test';

export const CONTROL_TOKEN = 'e2e-control-token-not-a-secret';

type Sim = { http: number; https: number; control: number; onvif: number; rtsp: number; baichuan: number; faults: object[] };

// A partial write's resets show at once (the firmware waits for a reboot).
const STRICT = { name: 'settings.strictPartial' };

export const SIMS: Record<'den' | 'porch' | 'shed' | 'barn' | 'silo', Sim> = {
  den: { http: 8098, https: 8198, control: 8298, onvif: 8398, rtsp: 8498, baichuan: 8598, faults: [STRICT] },
  // Porch always rejects SetWhiteLed, so settings.spec.ts can exercise a
  // partial save without making Den unreliable for the live specs.
  porch: { http: 8097, https: 8197, control: 8297, onvif: 8397, rtsp: 8497, baichuan: 8597, faults: [STRICT, { name: 'settings.fail', cmds: ['SetWhiteLed'] }] },
  // Shed refuses every recording download, like the real RLC-1224A since
  // 2026-09-26 (Plan 5 breaker and banner).
  shed: { http: 8096, https: 8196, control: 8296, onvif: 8396, rtsp: 8496, baichuan: 8596, faults: [STRICT, { name: 'downloads.refuse' }] },
  // Barn refuses downloads too, but has a cam-proxy (Plan 6, the fake in
  // test/proxy/fakeProxy.ts) whose clip plays instead; its live stream always
  // resets, so Live shows the gateway's stills (Plan 7).
  barn: { http: 8094, https: 8194, control: 8294, onvif: 8394, rtsp: 8494, baichuan: 8594, faults: [STRICT, { name: 'downloads.refuse' }, { name: 'flv.reset' }] },
  // Silo refuses HTTP Download like the real camera since 2026-10-01, and has
  // the real cam-proxy (e2e/realProxy.ts), which fetches its recordings over
  // Baichuan (spec 2026-10-02-recordings-via-proxy-design).
  silo: { http: 8090, https: 8190, control: 8290, onvif: 8390, rtsp: 8490, baichuan: 8590, faults: [STRICT, { name: 'downloads.refuse' }] },
};

export function simEnv(s: Sim): Record<string, string> {
  return {
    CAMSIM_USERS: 'e2e:admin:e2e-not-a-real-password',
    CAMSIM_CONTROL_TOKEN: CONTROL_TOKEN,
    CAMSIM_NAME: 'Den', // the on-screen name, for every camera
    CAMSIM_SEED_CLIPS: 'demo',
    CAMSIM_SD_MB: '61047', // the real camera's 64 GB card
    CAMSIM_HTTP_PORT: String(s.http),
    CAMSIM_HTTPS_PORT: String(s.https),
    CAMSIM_CONTROL_PORT: String(s.control),
    // Newer cam-sim versions also serve ONVIF and RTSP; three simulators on
    // one machine need their own ports.
    CAMSIM_ONVIF_PORT: String(s.onvif),
    CAMSIM_RTSP_PORT: String(s.rtsp),
    // cam-sim's Baichuan server (port 9000 by default); five simulators on one
    // machine need their own ports.
    CAMSIM_BAICHUAN_PORT: String(s.baichuan),
    CAMSIM_FAULTS: JSON.stringify(s.faults),
    CAMSIM_LOG_LEVEL: 'warn',
  };
}

// A simulator's counters, from its control API.
export async function simCounters(page: Page, cam: keyof typeof SIMS): Promise<Record<string, number>> {
  const res = await page.request.get(`http://127.0.0.1:${SIMS[cam].control}/sim/api/state`, {
    headers: { Authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  return (await res.json()).counters;
}
