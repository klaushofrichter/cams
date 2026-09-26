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

  // Fix round 1, item 6: 'custom' is only special for schedule fields
  // (motionRecording, record). An OSD name (or any other string field) the
  // user actually sets to "custom" must still appear in the patch.
  it('sends a non-schedule field whose new value happens to be "custom"', () => {
    const image = {
      dayNight: 'auto' as const,
      irLights: 'auto' as const,
      spotlight: { mode: 'off' as const, brightness: 50 },
      osd: { showName: true, name: 'Front Door', namePosition: 'Upper Left', showTime: true, timePosition: 'Lower Right' },
    };
    const edited = structuredClone(image);
    edited.osd.name = 'custom';
    expect(diffPatch(image, edited)).toEqual({ osd: { name: 'custom' } });
  });
});
