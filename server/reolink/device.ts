import { CameraConfig, webUiUrlOf } from '../cameraRegistry';
import { ReolinkClient } from './client';
import { AI_KINDS, AI_TYPE, detectionFrom, DetectionSettings, imageFrom, ImageSettings } from './settings';

// Reads go through command() one at a time: they share the camera's API gate.
export async function readDetection(client: ReolinkClient): Promise<DetectionSettings> {
  const rec = await client.command('GetRecV20', { channel: 0 });
  const md = await client.command('GetMdAlarm', { channel: 0 });
  const ai = {} as Record<(typeof AI_KINDS)[number], unknown>;
  for (const kind of AI_KINDS) ai[kind] = await client.command('GetAiAlarm', { channel: 0, ai_type: AI_TYPE[kind] });
  return detectionFrom({ rec, md, ai });
}

// The raw replies too: a save builds the untouched half of SetWhiteLed and
// SetOsd from them (see imageCommands).
export async function readImageRaw(client: ReolinkClient): Promise<{ raw: { wl: unknown; osd: unknown }; settings: ImageSettings }> {
  const isp = await client.command('GetIsp', { channel: 0 });
  const ir = await client.command('GetIrLights', { channel: 0 });
  const wl = await client.command('GetWhiteLed', { channel: 0 });
  const osd = await client.command('GetOsd', { channel: 0 });
  return { raw: { wl, osd }, settings: imageFrom({ isp, ir, wl, osd }) };
}

export async function readImage(client: ReolinkClient): Promise<ImageSettings> {
  return (await readImageRaw(client)).settings;
}

export interface DeviceInfo {
  model: string;
  firmware: string;
  hardware: string;
  name: string;
  storage: { totalMb: number; usedMb: number; mounted: boolean } | null;
  certificate: { subject: string; issuer: string; validTo: string; daysLeft: number } | null;
  webUiUrl: string;
}

export async function readDevice(cam: CameraConfig, client: ReolinkClient): Promise<DeviceInfo> {
  const dev = ((await client.command<{ DevInfo?: Record<string, string> }>('GetDevInfo')).DevInfo ?? {}) as Record<string, string>;
  const hdd = (await client.command<{ HddInfo?: { capacity: number; size: number; mount: number }[] }>('GetHddInfo')).HddInfo?.[0];
  const cert = await client.cameraCertificate();
  return {
    model: dev.model ?? '',
    firmware: dev.firmVer ?? '',
    hardware: dev.hardVer ?? '',
    name: dev.name ?? '',
    // GetHddInfo: capacity is the total and size the FREE space, in MB.
    storage: hdd ? { totalMb: hdd.capacity, usedMb: hdd.capacity - hdd.size, mounted: hdd.mount === 1 } : null,
    certificate: cert ? { ...cert, daysLeft: Math.floor((Date.parse(cert.validTo) - Date.now()) / 86_400_000) } : null,
    webUiUrl: webUiUrlOf(cam),
  };
}
