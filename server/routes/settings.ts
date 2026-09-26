import { Router, Request, Response, NextFunction } from 'express';
import { getCamera } from '../cameraRegistry';
import { CameraError } from '../reolink/client';
import { getClient } from '../reolink/clients';
import { readDetectionRaw, readDevice, readImageRaw } from '../reolink/device';
import {
  AI_TYPE, AiKind, changedKeys, detectionCommands, DetectionPatch, imageCommands, ImagePatch, patchApplied,
  SettingsCommand, validateDetectionPatch, validateImagePatch,
} from '../reolink/settings';
import { logger } from '../logger';
import { currentUser } from '../middleware/requireAuth';

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

function cameraOr404(req: Request, res: Response) {
  const cam = getCamera(String(req.params.id));
  const client = cam && getClient(cam.id);
  if (!cam || !client) {
    res.status(404).json({ error: 'unknown_camera' });
    return null;
  }
  return { cam, client };
}

function fail(err: unknown, cameraId: string, res: Response, next: NextFunction) {
  if (err instanceof CameraError) {
    logger.warn({ cameraId, code: err.code, message: err.message }, 'camera_request_failed');
    res.status(err.code === 'camera_error' ? 502 : 503).json({ error: err.code });
    return;
  }
  next(err);
}

// One command at a time; a failing command doesn't stop the rest (review
// focus 3). Every field is then judged against a fresh re-read.
async function apply(
  client: NonNullable<ReturnType<typeof getClient>>,
  commands: SettingsCommand[],
): Promise<Record<string, { ok: boolean; error?: string }>> {
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
  const c = cameraOr404(req, res);
  if (!c) return;
  try {
    res.json({ detection: (await readDetectionRaw(c.client)).settings, image: (await readImageRaw(c.client)).settings });
  } catch (err) {
    fail(err, c.cam.id, res, next);
  }
});

settingsRouter.put('/api/cameras/:id/settings/:section', async (req, res, next) => {
  const section = String(req.params.section);
  if (section !== 'detection' && section !== 'image') {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const c = cameraOr404(req, res);
  if (!c) return;
  const v = section === 'detection' ? validateDetectionPatch(req.body) : validateImagePatch(req.body);
  if (!v.ok) {
    res.status(400).json({ error: 'bad_request', details: v.details });
    return;
  }
  try {
    const before = section === 'detection' ? await readDetectionRaw(c.client) : await readImageRaw(c.client);
    const commands =
      section === 'detection'
        ? detectionCommands(v.patch as DetectionPatch, (before as Awaited<ReturnType<typeof readDetectionRaw>>).raw)
        : imageCommands(v.patch as ImagePatch, (before as Awaited<ReturnType<typeof readImageRaw>>).raw);
    const fields = await apply(c.client, commands);
    const after = section === 'detection' ? await readDetectionRaw(c.client) : await readImageRaw(c.client);
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
});

settingsRouter.get('/api/cameras/:id/device', async (req, res, next) => {
  const c = cameraOr404(req, res);
  if (!c) return;
  try {
    res.json(await readDevice(c.cam, c.client));
  } catch (err) {
    fail(err, c.cam.id, res, next);
  }
});

// A camera takes about a minute to come back; a second reboot in that time
// (a double click, a second tab) would only restart it again.
export const REBOOT_COOLDOWN_MS = 120_000;
const rebootedAt = new Map<string, number>();
export function resetRebootCooldowns(): void {
  rebootedAt.clear();
}

// Review focus 4: only the exact confirmation body reboots.
settingsRouter.post('/api/cameras/:id/reboot', async (req, res, next) => {
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
