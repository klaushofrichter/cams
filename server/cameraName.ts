// The camera's name rules, as measured on cam1 (firmware v3.2.0.6011,
// 2026-10-03; Obsidian "Reolink API Behaviour" → "Camera name"): 1–31
// characters; ASCII letters, digits, space and - ( ) + = [ ] { }; no space
// at the start or end. Anything else the camera refuses with rspCode -54,
// longer than 31 with -56, and a refused write leaves the old name.
// The same list as cam-proxy's (design reolink/camera-name-design.md, "API
// contract"). Pure, no imports: the server and the web app both use it.

export const CAMERA_NAME_MAX = 31;
export const CAMERA_NAME_PATTERN = /^[A-Za-z0-9()+=[\]{}-](?:[A-Za-z0-9 ()+=[\]{}-]{0,29}[A-Za-z0-9()+=[\]{}-])?$/;
const ALLOWED_CHAR = /^[A-Za-z0-9 ()+=[\]{}-]$/;

// Why the camera would refuse this name, or null when it takes it.
export function cameraNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'Enter a name.';
  const bad = [...new Set([...name].filter((c) => !ALLOWED_CHAR.test(c)))];
  if (bad.length) return `Not allowed: ${bad.map(shown).join(' ')}. Use letters A–Z, digits, space and - ( ) + = [ ] { }.`;
  if (name.length > CAMERA_NAME_MAX) return `Too long: at most ${CAMERA_NAME_MAX} characters.`;
  if (name.startsWith(' ') || name.endsWith(' ')) return 'No space at the start or end.';
  return CAMERA_NAME_PATTERN.test(name) ? null : 'Not a valid camera name.';
}

export const validCameraName = (name: unknown): name is string => cameraNameProblem(name) === null;

// The camera's own refusal, as a reason for the person (rspCode -54: a
// character it doesn't take, -56: too long).
export function cameraRefusalReason(rspCode: number | undefined): string {
  if (rspCode === -56) return `Too long: at most ${CAMERA_NAME_MAX} characters.`;
  if (rspCode === -54) return 'Not allowed by the camera: letters A–Z, digits, space and - ( ) + = [ ] { } only.';
  return 'The camera refused the name.';
}

// A character as the reason shows it: invisible ones by code point.
function shown(c: string): string {
  return /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(c) ? c : `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}
