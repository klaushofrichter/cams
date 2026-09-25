import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { logger } from './logger';

export interface CameraConfig {
  id: string;
  name: string;
  host: string;
  user: string;
  password: string;
}

export interface CameraSummary {
  id: string;
  name: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FIELDS = ['id', 'name', 'host', 'user', 'password'] as const;

let cameras: CameraConfig[] = [];

// The registry comes from the cams-cameras Secret, mounted as a file. A
// configured path that doesn't exist yet (Secret not created) means "no
// cameras" so the app still starts; anything present but wrong fails startup
// with a message naming the problem, never a half-loaded list.
export function loadCameras(file: string | undefined = process.env.CAMERAS_FILE): CameraConfig[] {
  if (!file) return [];
  if (!existsSync(file)) {
    logger.warn({ file: basename(file) }, 'camera registry file not found; no cameras configured');
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`camera registry ${basename(file)} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`camera registry ${basename(file)} must be a JSON array`);

  const seen = new Set<string>();
  return parsed.map((entry: unknown, i: number) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`camera registry entry ${i} is not an object`);
    const e = entry as Record<string, unknown>;
    for (const field of FIELDS) {
      if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
        throw new Error(`camera registry entry ${i}: field "${field}" must be a non-empty string`);
      }
    }
    if (!ID_PATTERN.test(e.id as string)) {
      throw new Error(`camera registry entry ${i}: id must match ${ID_PATTERN}`);
    }
    if (seen.has(e.id as string)) throw new Error(`camera registry: duplicate id "${e.id}"`);
    seen.add(e.id as string);
    return { id: e.id, name: e.name, host: e.host, user: e.user, password: e.password } as CameraConfig;
  });
}

export function setCameras(list: CameraConfig[]): void {
  cameras = list;
}

export function listCameras(): CameraSummary[] {
  return cameras.map(({ id, name }) => ({ id, name }));
}

export function getCamera(id: string): CameraConfig | undefined {
  return cameras.find((c) => c.id === id);
}
