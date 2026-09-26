import { Router, Request, Response, NextFunction } from 'express';
import { getCamera } from '../cameraRegistry';
import { CameraError } from '../reolink/client';
import { getClient } from '../reolink/clients';
import { readDetection, readDevice, readImage, readImageRaw } from '../reolink/device';
import {
  detectionCommands, DetectionPatch, imageCommands, ImagePatch, patchApplied,
  SettingsCommand, validateDetectionPatch, validateImagePatch,
} from '../reolink/settings';
import { logger } from '../logger';
import { currentUser } from '../middleware/requireAuth';

export const settingsRouter = Router();

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
      fields[c.field] = { ok: true };
    } catch (err) {
      if (err instanceof CameraError && err.code !== 'camera_error') throw err; // offline/auth: whole request fails
      fields[c.field] = { ok: false, error: 'camera_rejected' };
    }
  }
  return fields;
}

settingsRouter.get('/api/cameras/:id/settings', async (req, res, next) => {
  const c = cameraOr404(req, res);
  if (!c) return;
  try {
    res.json({ detection: await readDetection(c.client), image: await readImage(c.client) });
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
    const commands =
      section === 'detection'
        ? detectionCommands(v.patch as DetectionPatch)
        : imageCommands(v.patch as ImagePatch, (await readImageRaw(c.client)).raw);
    const fields = await apply(c.client, commands);
    const settings = section === 'detection' ? await readDetection(c.client) : await readImage(c.client);
    for (const [field, r] of Object.entries(fields)) {
      if (r.ok && !patchApplied(field, v.patch, settings)) fields[field] = { ok: false, error: 'not_applied' };
    }
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

// Review focus 4: only the exact confirmation body reboots.
settingsRouter.post('/api/cameras/:id/reboot', async (req, res, next) => {
  const c = cameraOr404(req, res);
  if (!c) return;
  if (req.body?.confirm !== 'reboot' || Object.keys(req.body).length !== 1) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const by = currentUser(req)?.email;
  try {
    await c.client.command('Reboot', {});
    logger.info({ cameraId: c.cam.id, by }, 'camera_reboot_requested');
    res.json({ ok: true });
  } catch (err) {
    // The camera may drop the connection as it goes down, before answering.
    // The command was sent, so report it as sent but unconfirmed.
    if (err instanceof CameraError && err.code === 'camera_offline') {
      logger.info({ cameraId: c.cam.id, by }, 'camera_reboot_unconfirmed');
      res.status(202).json({ ok: true, confirmed: false });
      return;
    }
    fail(err, c.cam.id, res, next);
  }
});
