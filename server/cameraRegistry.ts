import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { logger } from './logger';

export interface CameraConfig {
  id: string;
  name: string;
  host: string; // IP or hostname, optionally with :port
  protocol: 'https' | 'http';
  // When set, the camera's TLS certificate is verified against this name
  // (the camera is reached by IP, but its certificate is for a hostname).
  tlsServername?: string;
  user: string;
  password: string;
}

export interface CameraSummary {
  id: string;
  name: string;
  webUiUrl: string;
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
    if (e.protocol !== undefined && e.protocol !== 'https' && e.protocol !== 'http') {
      throw new Error(`camera registry entry ${i}: protocol must be "https" or "http"`);
    }
    if (e.tlsServername !== undefined && (typeof e.tlsServername !== 'string' || e.tlsServername.length === 0)) {
      throw new Error(`camera registry entry ${i}: tlsServername must be a non-empty string`);
    }
    const camera: CameraConfig = {
      id: e.id as string,
      name: e.name as string,
      host: e.host as string,
      protocol: (e.protocol as 'https' | 'http' | undefined) ?? 'https',
      user: e.user as string,
      password: e.password as string,
    };
    if (e.tlsServername !== undefined) camera.tlsServername = e.tlsServername as string;
    return camera;
  });
}

export function setCameras(list: CameraConfig[]): void {
  cameras = list;
}

export function listCameras(): CameraSummary[] {
  return cameras.map((c) => ({ id: c.id, name: c.name, webUiUrl: webUiUrlOf(c) }));
}

export function getCamera(id: string): CameraConfig | undefined {
  return cameras.find((c) => c.id === id);
}

// The camera's own web UI, by LAN address: it's reachable from the home
// network only (docs/reolink-api.md, "Camera authentication").
export function webUiUrlOf(cam: CameraConfig): string {
  const host = cam.host.startsWith('[') ? cam.host.slice(0, cam.host.indexOf(']') + 1) : cam.host.split(':')[0];
  return `https://${host}/`;
}
