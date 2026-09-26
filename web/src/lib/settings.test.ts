import { describe, expect, it } from 'vitest';
import { diffPatch } from './settings';

const detection = {
  recording: true,
  motionRecording: 'custom' as const,
  motionSensitivity: 41,
  ai: { person: { record: 'on' as const, sensitivity: 60 }, vehicle: { record: 'on' as const, sensitivity: 60 }, pet: { record: 'off' as const, sensitivity: 60 } },
};

describe('diffPatch', () => {
  it('sends only changed fields', () => {
    const edited = structuredClone(detection);
    edited.motionSensitivity = 30;
    edited.ai.pet.sensitivity = 80;
    expect(diffPatch(detection, edited)).toEqual({ motionSensitivity: 30, ai: { pet: { sensitivity: 80 } } });
  });

  // Review focus 5.
  it('never sends an untouched custom schedule', () => {
    const edited = structuredClone(detection);
    edited.recording = false;
    expect(diffPatch(detection, edited)).toEqual({ recording: false });
  });

  it('returns an empty patch when nothing changed', () => {
    expect(diffPatch(detection, structuredClone(detection))).toEqual({});
  });
});
