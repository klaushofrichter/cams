import { describe, expect, it } from 'vitest';
import { CAMERA_NAME_MAX, CAMERA_NAME_PATTERN, cameraNameProblem, cameraRefusalReason, validCameraName } from '../server/cameraName';

// The measured cases (cam1, firmware v3.2.0.6011, 2026-10-03): the camera
// takes these and refuses the rest (-54 a character, -56 too long).
describe('camera name rules', () => {
  it.each(['Den', 'Backyard Left', 'A', '1', 'a-b (c) [d] {e} +=', '(x)', 'x'.repeat(31), `${'x'.repeat(29)} y`])('takes %j', (name) => {
    expect(cameraNameProblem(name)).toBeNull();
    expect(validCameraName(name)).toBe(true);
    expect(CAMERA_NAME_PATTERN.test(name)).toBe(true);
  });

  it('31 characters are fine, 32 are too long', () => {
    expect(CAMERA_NAME_MAX).toBe(31);
    expect(cameraNameProblem('x'.repeat(31))).toBeNull();
    expect(cameraNameProblem('x'.repeat(32))).toBe('Too long: at most 31 characters.');
    expect(CAMERA_NAME_PATTERN.test('x'.repeat(32))).toBe(false);
  });

  it.each(['_', '.', ',', '!', '@', '#', '$', '%', '^', '&', '*', '/', '\\', '|', '<', '>', '?', ':', ';', "'", '"', '`', '~', 'é', 'ß', '門', '😀', '\t', '​'])(
    'refuses %j and names it',
    (c) => {
      const problem = cameraNameProblem(`Den${c}x`);
      expect(problem).toMatch(/^Not allowed: /);
      expect(CAMERA_NAME_PATTERN.test(`Den${c}x`)).toBe(false);
    },
  );

  it('shows an invisible character by its code point', () => {
    expect(cameraNameProblem('Den​')).toContain('U+200B');
    expect(cameraNameProblem('Den_Left')).toContain('Not allowed: _.');
  });

  it.each([' Den', 'Den ', ' ', '  Den  '])('refuses a leading or trailing space in %j', (name) => {
    expect(cameraNameProblem(name)).toBe('No space at the start or end.');
    expect(CAMERA_NAME_PATTERN.test(name)).toBe(false);
  });

  it.each(['', null, undefined, 3])('refuses an empty or missing name (%j)', (name) => {
    expect(cameraNameProblem(name)).toBe('Enter a name.');
  });

  it('turns the camera refusal codes into reasons', () => {
    expect(cameraRefusalReason(-56)).toMatch(/Too long/);
    expect(cameraRefusalReason(-54)).toMatch(/Not allowed/);
    expect(cameraRefusalReason(undefined)).toMatch(/refused/);
  });
});
