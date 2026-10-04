import { cameras } from './stores';
import { putJson } from './settings';

// The camera's name (design camera-name-design.md): the camera stores it,
// cams shows it and renames it. The rules are the server's own module
// (server/cameraName.ts), so the field and the server never disagree.
export { CAMERA_NAME_MAX, cameraNameProblem } from '../../../server/cameraName';

// One camera's shown name, everywhere at once (picker, titles, cards).
export function setCameraName(id: string, name: string): void {
  cameras.update((list) => (list.some((c) => c.id === id && c.name !== name) ? list.map((c) => (c.id === id ? { ...c, name } : c)) : list));
}

export type RenameResult = { ok: true; name: string } | { ok: false; message: string };

// PUT /api/cameras/:id/name: the name read back from the camera, or what to
// show under the field.
export async function renameCamera(id: string, name: string): Promise<RenameResult> {
  const failed: RenameResult = { ok: false, message: 'Could not save the name. Try again.' };
  let res: { status: number; body: { name?: unknown; error?: unknown; reason?: unknown } };
  try {
    res = await putJson(`/api/cameras/${encodeURIComponent(id)}/name`, { name });
  } catch {
    return failed;
  }
  if (res.status === 200 && typeof res.body.name === 'string') {
    setCameraName(id, res.body.name);
    return { ok: true, name: res.body.name };
  }
  if (res.status === 400) return { ok: false, message: typeof res.body.reason === 'string' && res.body.reason ? res.body.reason : 'The camera refused the name.' };
  if (res.status === 503) return { ok: false, message: 'Camera offline. Try again when it is back.' };
  if (res.body.error === 'camera_error') return { ok: false, message: 'The camera refused the change.' };
  return failed;
}
