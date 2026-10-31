import { Router, Request, Response, NextFunction } from 'express';
import { setTimeout as sleep } from 'timers/promises';
import { getCamera, proxyActive, setReportedName } from '../cameraRegistry';
import { plausibleName } from '../proxy/names';
import { CameraError } from '../reolink/client';
import { getClient } from '../reolink/clients';
import { readDetectionRaw, readDevice, readImageRaw } from '../reolink/device';
import {
  AI_TYPE, AiKind, changedKeys, detectionCommands, DetectionPatch, DetectionSettings, imageCommands, ImagePatch, ImageSettings, patchApplied,
  RawDetection, RawImage, SettingsCommand, validateDetectionPatch, validateImagePatch,
} from '../reolink/settings';
import { logger } from '../logger';
import { currentUser } from '../middleware/requireAuth';
import { knownCamera, sendCameraError as fail, viaProxyFailed } from './common';
import { throughProxy } from '../proxy/features';
import { proxyAdminClient, readProxyStatus } from '../proxy/cameraCalls';
import { readJson } from './common';
import { proxyPath, requireProxyClient } from '../proxy/client';
import { webUiOf } from '../cameraRegistry';
import type { CamKey } from '../fleet';

export const settingsRouter = Router();

// A changed key is expected only if the camera now holds exactly the value
// a write sent for it (and that value differs from before). Paths from
// changedKeys() look like "osd.Osd.osdChannel.name": the RawImage or
// RawDetection key, the reply wrapper, then the object's own keys.
function at(o: unknown, path: string[]): unknown {
  for (const k of path) {
    if (typeof o !== 'object' || o === null) return undefined;
    o = (o as Record<string, unknown>)[k];
  }
  return o;
}
function expectedChange(key: string, commands: SettingsCommand[], after: unknown): boolean {
  const parts = key.split('.');
  const now = JSON.stringify(at(after, parts));
  return commands.some((c) => {
    const [wrap, body] = Object.entries(c.param as Record<string, unknown>)[0];
    const i = parts.indexOf(wrap);
    if (i < 0) return false;
    // ai.<kind>.AiAlarm.…: only the command for that AI type counts.
    if (parts[0] === 'ai' && (body as Record<string, unknown>)?.ai_type !== AI_TYPE[parts[1] as AiKind]) return false;
    return JSON.stringify(at(body, parts.slice(i + 1))) === now;
  });
}

// A camera reached through its proxy only (spec §6.1): its key; undefined
// for a camera called directly; null for an unknown one (answered 404 here).
function viaProxy(req: Request, res: Response): CamKey | undefined | null {
  const key = knownCamera(req, res);
  if (!key) return null;
  return throughProxy(key) ? key : undefined;
}

// A camera-changing call with the proxy-admin token (spec §10.1): the
// proxy's status and JSON body (null when it sent none).
async function adminCall(id: CamKey, method: 'PUT' | 'POST', path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> | null; retryAfter: string | null }> {
  const up = await proxyAdminClient(id).open(proxyPath(id, path), undefined, { method, body: JSON.stringify(body), timeoutMs: 30_000 });
  const json = await readJson(up);
  return { status: up.status, body: json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null, retryAfter: up.headers.get('retry-after') };
}

// The proxy's own refusals of a camera call: its 503 camera_offline as ours, anything else unavailable.
function adminRefused(res: Response, id: CamKey, a: { status: number; body: Record<string, unknown> | null }, event: string): void {
  if (a.status === 503 || (a.status === 502 && a.body?.error === 'camera_offline')) return void res.status(503).json({ error: 'camera_offline' });
  logger.warn({ cameraId: id, status: a.status, upstream: typeof a.body?.error === 'string' ? a.body.error.slice(0, 64) : undefined }, event);
  res.status(502).json({ error: a.status === 502 && a.body?.error === 'camera_error' ? 'camera_error' : 'proxy_unavailable' });
}

function cameraOr404(req: Request, res: Response) {
  const key = knownCamera(req, res);
  if (!key) return null;
  const cam = getCamera(key);
  const client = cam && getClient(key);
  if (cam && !client && cam.credentials !== 'ok') {
    res.status(503).json({ error: 'camera_credentials_missing' });
    return null;
  }
  if (!cam || !client) {
    res.status(404).json({ error: 'unknown_camera' });
    return null;
  }
  return { cam, client };
}

type Client = NonNullable<ReturnType<typeof getClient>>;

// One command at a time; a failing command doesn't stop the rest (review
// focus 3). Every field is then judged against a fresh re-read.
async function apply(client: Client, commands: SettingsCommand[]): Promise<Record<string, { ok: boolean; error?: string }>> {
  const fields: Record<string, { ok: boolean; error?: string }> = {};
  for (const c of commands) {
    try {
      await client.command(c.cmd, c.param);
      for (const f of c.fields) fields[f] = { ok: true };
    } catch (err) {
      if (err instanceof CameraError && err.code !== 'camera_error') throw err; // offline/auth: whole request fails
      for (const f of c.fields) fields[f] = { ok: false, error: 'camera_rejected' };
    }
  }
  return fields;
}

settingsRouter.get('/api/cameras/:id/settings', async (req, res, next) => {
  const p = viaProxy(req, res);
  if (p === null) return;
  if (p) {
    try {
      const s = await requireProxyClient(p).json<{ detection?: unknown; image?: unknown }>(proxyPath(p, '/settings'), undefined, { timeoutMs: 20_000 });
      return void res.json({ detection: s?.detection ?? null, image: s?.image ?? null });
    } catch (err) {
      return viaProxyFailed(err, p, res, next);
    }
  }
  const c = cameraOr404(req, res);
  if (!c) return;
  try {
    res.json({ detection: (await readDetectionRaw(c.client)).settings, image: (await readImageRaw(c.client)).settings });
  } catch (err) {
    fail(err, c.cam.id, res, next);
  }
});

// The two writable sections of the Settings page.
interface Section<P, R> {
  validate(body: unknown): { ok: true; patch: P } | { ok: false; details: string[] };
  read(client: Client): Promise<{ raw: R; settings: DetectionSettings | ImageSettings }>;
  commands(patch: P, raw: R): SettingsCommand[];
}
const DETECTION: Section<DetectionPatch, RawDetection> = { validate: validateDetectionPatch, read: readDetectionRaw, commands: detectionCommands };
const IMAGE: Section<ImagePatch, RawImage> = { validate: validateImagePatch, read: readImageRaw, commands: imageCommands };

settingsRouter.put('/api/cameras/:id/settings/:section', async (req, res, next) => {
  const section = String(req.params.section);
  const p = section === 'detection' || section === 'image' ? viaProxy(req, res) : undefined;
  if (p === null) return;
  if (p) {
    try {
      const a = await adminCall(p, 'PUT', `/settings/${section}`, req.body ?? {});
      if ((a.status === 200 || a.status === 207) && a.body) return void res.status(a.status).json({ fields: a.body.fields, settings: a.body.settings });
      if (a.status === 400) return void res.status(400).json({ error: 'bad_request', details: Array.isArray(a.body?.details) ? a.body.details.filter((d) => typeof d === 'string').slice(0, 50) : [] });
      return adminRefused(res, p, a, 'camera_settings_failed');
    } catch (err) {
      return viaProxyFailed(err, p, res, next);
    }
  }
  if (section === 'detection') return writeSection(DETECTION, section, req, res, next);
  if (section === 'image') return writeSection(IMAGE, section, req, res, next);
  res.status(404).json({ error: 'not found' });
});

async function writeSection<P extends DetectionPatch | ImagePatch, R>(s: Section<P, R>, section: string, req: Request, res: Response, next: NextFunction): Promise<void> {
  const c = cameraOr404(req, res);
  if (!c) return;
  const v = s.validate(req.body);
  if (!v.ok) {
    res.status(400).json({ error: 'bad_request', details: v.details });
    return;
  }
  try {
    const before = await s.read(c.client);
    const commands = s.commands(v.patch, before.raw);
    const fields = await apply(c.client, commands);
    const after = await s.read(c.client);
    const settings = after.settings;
    for (const [field, r] of Object.entries(fields)) {
      if (r.ok && !patchApplied(field, v.patch, settings)) fields[field] = { ok: false, error: 'not_applied' };
    }
    // A write sent the whole object, so after it the camera's object should
    // equal exactly what was sent. Anything else moved on its own: log it
    // (key names only) so a firmware surprise is visible, not silent.
    const unexpected = changedKeys(before.raw, after.raw).filter((key) => !expectedChange(key, commands, after.raw));
    if (unexpected.length) logger.warn({ cameraId: c.cam.id, section, keys: unexpected.slice(0, 20) }, 'camera_setting_side_effect');
    const allOk = Object.values(fields).every((f) => f.ok);
    res.status(allOk ? 200 : 207).json({ fields, settings });
  } catch (err) {
    fail(err, c.cam.id, res, next);
  }
}

settingsRouter.get('/api/cameras/:id/device', async (req, res, next) => {
  const p = viaProxy(req, res);
  if (p === null) return;
  if (p) {
    try {
      const s = await readProxyStatus(p, { timeoutMs: 20_000 });
      const cam = getCamera(p)!;
      return void res.json({
        model: s.model ?? '',
        firmware: s.firmware ?? '',
        hardware: s.hardware ?? '',
        name: s.name ?? '',
        storage: s.sd && s.sd.capacityMB !== null ? { totalMb: s.sd.capacityMB, usedMb: s.sd.capacityMB - (s.sd.freeMB ?? 0), mounted: s.sd.mounted } : null,
        certificate: s.certificate ? { ...s.certificate, daysLeft: Math.floor((Date.parse(s.certificate.validTo) - Date.now()) / 86_400_000) } : null,
        ...webUiOf(cam),
      });
    } catch (err) {
      return viaProxyFailed(err, p, res, next);
    }
  }
  const c = cameraOr404(req, res);
  if (!c) return;
  try {
    const device = await readDevice(c.cam, c.client);
    if (!proxyActive(c.cam.id) && plausibleName(device.name)) setReportedName(c.cam.id, device.name);
    res.json(device);
  } catch (err) {
    fail(err, c.cam.id, res, next);
  }
});

// The camera's manual light: WhiteLed.state, 1 on, 0 off. It stays on until
// switched off (measured on cam1 2026-09-29). The write sends the whole
// object, like every settings write, then the light is re-read. The camera
// reports the new state late, about 1 s after switching on and 3 s after
// switching off (measured 2026-09-30), so the re-read is repeated for up to
// 5 s before the switch counts as not applied.
const LIGHT_WAIT_MS = 5000;
const LIGHT_POLL_MS = 250;
async function readWhiteLed(client: Client): Promise<Record<string, unknown>> {
  const r = await client.command<{ WhiteLed?: Record<string, unknown> }>('GetWhiteLed', { channel: 0 });
  return r.WhiteLed ?? {};
}

settingsRouter.get('/api/cameras/:id/light', async (req, res, next) => {
  const p = viaProxy(req, res);
  if (p === null) return;
  if (p) {
    try {
      const l = await requireProxyClient(p).json<{ on?: unknown }>(proxyPath(p, '/light'));
      return void res.json({ on: l?.on === true });
    } catch (err) {
      return viaProxyFailed(err, p, res, next);
    }
  }
  const c = cameraOr404(req, res);
  if (!c) return;
  try {
    res.json({ on: (await readWhiteLed(c.client)).state === 1 });
  } catch (err) {
    fail(err, c.cam.id, res, next);
  }
});

settingsRouter.put('/api/cameras/:id/light', async (req, res, next) => {
  const body = req.body as unknown;
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { on?: unknown }).on !== 'boolean') {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const want = (body as { on: boolean }).on;
  const p = viaProxy(req, res);
  if (p === null) return;
  if (p) {
    try {
      const a = await adminCall(p, 'PUT', '/light', { on: want });
      const on = a.body?.on === true;
      if (a.status === 200 || (a.status === 502 && a.body?.error === 'not_applied')) logger.info({ cameraId: p, on, by: currentUser(req)?.email, via: 'proxy' }, 'camera_light_switched');
      if (a.status === 200) return void res.json({ on });
      if (a.status === 502 && a.body?.error === 'not_applied') return void res.status(502).json({ error: 'not_applied', on });
      return adminRefused(res, p, a, 'camera_light_failed');
    } catch (err) {
      return viaProxyFailed(err, p, res, next);
    }
  }
  const c = cameraOr404(req, res);
  if (!c) return;
  try {
    const before = await readWhiteLed(c.client);
    if ((before.state === 1) !== want) {
      await c.client.command('SetWhiteLed', { WhiteLed: { ...before, channel: 0, state: want ? 1 : 0 } });
      const until = Date.now() + LIGHT_WAIT_MS;
      let on = (await readWhiteLed(c.client)).state === 1;
      while (on !== want && Date.now() < until) {
        await sleep(LIGHT_POLL_MS);
        on = (await readWhiteLed(c.client)).state === 1;
      }
      logger.info({ cameraId: c.cam.id, on, by: currentUser(req)?.email }, 'camera_light_switched');
      if (on !== want) {
        res.status(502).json({ error: 'not_applied', on });
        return;
      }
    }
    res.json({ on: want });
  } catch (err) {
    fail(err, c.cam.id, res, next);
  }
});

// A camera takes about a minute to come back; a second reboot in that time
// (a double click, a second tab) would only restart it again.
const REBOOT_COOLDOWN_MS = 120_000;
const rebootedAt = new Map<CamKey, number>();
export function resetRebootCooldowns(): void {
  rebootedAt.clear();
}

// Review focus 4: only the exact confirmation body reboots.
settingsRouter.post('/api/cameras/:id/reboot', async (req, res, next) => {
  const p = viaProxy(req, res);
  if (p === null) return;
  if (p) {
    if (req.body?.confirm !== 'reboot' || Object.keys(req.body).length !== 1) return void res.status(400).json({ error: 'bad_request' });
    // The proxy counts the cooldown (shared with its power-cycle), not cams.
    try {
      const a = await adminCall(p, 'POST', '/reboot', { confirm: 'reboot' });
      const by = currentUser(req)?.email;
      if (a.status === 202 && a.body?.confirmed === true) {
        logger.info({ cameraId: p, by, via: 'proxy' }, 'camera_reboot_requested');
        return void res.json({ ok: true });
      }
      if (a.status === 202) {
        logger.info({ cameraId: p, by, via: 'proxy' }, 'camera_reboot_unconfirmed');
        return void res.status(202).json({ ok: true, confirmed: false });
      }
      if (a.status === 429) return void res.status(429).json({ error: 'reboot_cooldown' });
      return adminRefused(res, p, a, 'camera_reboot_failed');
    } catch (err) {
      return viaProxyFailed(err, p, res, next);
    }
  }
  const c = cameraOr404(req, res);
  if (!c) return;
  if (req.body?.confirm !== 'reboot' || Object.keys(req.body).length !== 1) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const last = rebootedAt.get(c.cam.id);
  if (last !== undefined && Date.now() - last < REBOOT_COOLDOWN_MS) {
    res.status(429).json({ error: 'reboot_cooldown' });
    return;
  }
  // Claimed before sending, so two requests at once can't both reboot.
  rebootedAt.set(c.cam.id, Date.now());
  const by = currentUser(req)?.email;
  try {
    await c.client.command('Reboot', {});
    logger.info({ cameraId: c.cam.id, by }, 'camera_reboot_requested');
    res.json({ ok: true });
  } catch (err) {
    // The camera may drop the connection as it goes down, before answering.
    // If the request was written first, report it as sent but unconfirmed.
    if (err instanceof CameraError && err.code === 'camera_offline' && err.requestSent) {
      logger.info({ cameraId: c.cam.id, by }, 'camera_reboot_unconfirmed');
      res.status(202).json({ ok: true, confirmed: false });
      return;
    }
    // Never reached the camera (refused, unreachable, login failed): no
    // reboot happened, so no cooldown either.
    rebootedAt.delete(c.cam.id);
    fail(err, c.cam.id, res, next);
  }
});
