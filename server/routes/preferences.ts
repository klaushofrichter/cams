import { Router } from 'express';
import { currentUser } from '../middleware/requireAuth';
import { getPreferences, savePreferences, validatePreferencesPatch } from '../preferences';
import { sessionAccount } from './common';

export const preferencesRouter = Router();

preferencesRouter.get('/api/preferences', async (req, res, next) => {
  try {
    res.json(await getPreferences(sessionAccount(req, res), currentUser(req)!.email));
  } catch (err) {
    next(err);
  }
});

preferencesRouter.put('/api/preferences', async (req, res, next) => {
  const v = validatePreferencesPatch(sessionAccount(req, res).id, req.body);
  if (!v.ok) {
    res.status(400).json({ error: 'bad_request', details: v.details });
    return;
  }
  try {
    res.json(await savePreferences(sessionAccount(req, res), currentUser(req)!.email, v.patch));
  } catch (err) {
    next(err);
  }
});
