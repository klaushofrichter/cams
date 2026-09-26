import { describe, expect, it } from 'vitest';
import {
  detectionCommands, detectionFrom, imageCommands, imageFrom, patchApplied,
  validateDetectionPatch, validateImagePatch,
} from '../server/reolink/settings';

const ALL = '1'.repeat(168);
const NONE = '0'.repeat(168);
// Shapes as returned by the real RLC-1224A (fw v3.2.0.6011), trimmed.
const REAL = {
  rec: { Rec: { enable: 1, schedule: { channel: 0, table: { MD: ALL, AI_PEOPLE: ALL, AI_VEHICLE: ALL, AI_DOG_CAT: ALL, TIMING: NONE } } } },
  md: { MdAlarm: { channel: 0, useNewSens: 1, newSens: { sensDef: 10 } } },
  ai: {
    person: { AiAlarm: { ai_type: 'people', sensitivity: 60 } },
    vehicle: { AiAlarm: { ai_type: 'vehicle', sensitivity: 50 } },
    pet: { AiAlarm: { ai_type: 'dog_cat', sensitivity: 40 } },
  },
  isp: { Isp: { channel: 0, dayNight: 'Auto', antiFlicker: '60HZ' } },
  ir: { IrLights: { state: 'Auto' } },
  wl: { WhiteLed: { channel: 0, mode: 1, bright: 100, state: 0 } },
  osd: { Osd: { channel: 0, osdChannel: { enable: 1, name: 'Den', pos: 'Lower Right' }, osdTime: { enable: 1, pos: 'Top Center' } } },
};

describe('reading settings', () => {
  it('maps the real camera replies', () => {
    expect(detectionFrom(REAL)).toEqual({
      recording: true,
      motionRecording: 'on',
      motionSensitivity: 41, // 51 - sensDef 10: higher = more sensitive
      ai: {
        person: { record: 'on', sensitivity: 60 },
        vehicle: { record: 'on', sensitivity: 50 },
        pet: { record: 'on', sensitivity: 40 },
      },
    });
    expect(imageFrom(REAL)).toEqual({
      dayNight: 'auto',
      irLights: 'auto',
      spotlight: { mode: 'auto', brightness: 100 },
      osd: { showName: true, name: 'Den', namePosition: 'Lower Right', showTime: true, timePosition: 'Top Center' },
    });
  });

  // Review focus 5.
  it('reports a partly-on schedule as custom', () => {
    const custom = '1'.repeat(84) + '0'.repeat(84);
    const d = detectionFrom({ ...REAL, rec: { Rec: { enable: 0, schedule: { table: { MD: custom, AI_PEOPLE: NONE, AI_VEHICLE: ALL, AI_DOG_CAT: ALL } } } } });
    expect(d.recording).toBe(false);
    expect(d.motionRecording).toBe('custom');
    expect(d.ai.person.record).toBe('off');
  });

  it('maps every day/night, spotlight and IR value', () => {
    const img = (isp: string, mode: number, ir: string) =>
      imageFrom({ ...REAL, isp: { Isp: { dayNight: isp } }, wl: { WhiteLed: { mode, bright: 5 } }, ir: { IrLights: { state: ir } } });
    expect(img('Color', 0, 'Off')).toMatchObject({ dayNight: 'color', irLights: 'off', spotlight: { mode: 'off', brightness: 5 } });
    expect(img('Black&White', 2, 'Auto')).toMatchObject({ dayNight: 'blackwhite', spotlight: { mode: 'night' } });
    expect(img('Auto', 3, 'Auto').spotlight.mode).toBe('schedule');
  });
});

describe('validating patches', () => {
  it('accepts valid detection and image patches', () => {
    expect(validateDetectionPatch({ recording: false, motionSensitivity: 50, ai: { pet: { sensitivity: 0, record: 'off' } } })).toEqual({
      ok: true,
      patch: { recording: false, motionSensitivity: 50, ai: { pet: { sensitivity: 0, record: 'off' } } },
    });
    expect(validateImagePatch({ spotlight: { brightness: 0 }, osd: { name: 'Front door' } }).ok).toBe(true);
    expect(validateImagePatch({ osd: { name: 'x'.repeat(31) } }).ok).toBe(true);
    expect(validateImagePatch({ osd: { name: '門'.repeat(10) } }).ok).toBe(true); // 30 bytes
  });

  // Review focus 2.
  it.each([
    [{ motionSensitivity: 0 }],
    [{ motionSensitivity: 51 }],
    [{ motionSensitivity: 10.5 }],
    [{ ai: { person: { sensitivity: 101 } } }],
    [{ ai: { cat: { sensitivity: 5 } } }],
    [{ motionRecording: 'custom' }],
    [{ recording: 'yes' }],
    [{ surprise: 1 }],
    ['not an object'],
  ])('rejects detection patch %j', (body) => {
    expect(validateDetectionPatch(body).ok).toBe(false);
  });

  it.each([
    [{ dayNight: 'Purple' }],
    [{ dayNight: 'toString' }],
    [{ dayNight: 'constructor' }],
    [{ irLights: 'hasOwnProperty' }],
    [{ irLights: 'on' }],
    [{ spotlight: { mode: 'disco' } }],
    [{ spotlight: { brightness: 101 } }],
    [{ osd: { name: '' } }],
    [{ osd: { name: 'x'.repeat(32) } }],
    [{ osd: { name: 'bad\nname' } }],
    [{ osd: { name: '門'.repeat(11) } }], // 11 characters, but 33 bytes
    [{ osd: { name: '\u200bDen' } }], // zero-width space
    [{ osd: { name: 'Den\u202e' } }], // bidi override
    [{ osd: { name: 'Den\u0085' } }], // C1 control
    [{ osd: { name: '   ' } }],
    [{ osd: { namePosition: 'Middle' } }],
    [{ osd: { extra: true } }],
  ])('rejects image patch %j', (body) => {
    expect(validateImagePatch(body).ok).toBe(false);
  });
});

describe('building commands', () => {
  it('writes only what changed, one command per field, in a stable order', () => {
    expect(detectionCommands({ recording: false, motionSensitivity: 50, ai: { vehicle: { record: 'off', sensitivity: 70 } } })).toEqual([
      { field: 'recording', cmd: 'SetRecV20', param: { Rec: { enable: 0 } } },
      { field: 'motionSensitivity', cmd: 'SetMdAlarm', param: { MdAlarm: { channel: 0, useNewSens: 1, newSens: { sensDef: 1 } } } },
      { field: 'ai.vehicle.record', cmd: 'SetRecV20', param: { Rec: { schedule: { channel: 0, table: { AI_VEHICLE: NONE } } } } },
      { field: 'ai.vehicle.sensitivity', cmd: 'SetAiAlarm', param: { AiAlarm: { channel: 0, ai_type: 'vehicle', sensitivity: 70 } } },
    ]);
    expect(detectionCommands({ motionRecording: 'on' })).toEqual([
      { field: 'motionRecording', cmd: 'SetRecV20', param: { Rec: { schedule: { channel: 0, table: { MD: ALL } } } } },
    ]);
  });

  it('keeps the unchanged OSD half when only one part changes', () => {
    expect(imageCommands({ osd: { name: 'Porch' }, dayNight: 'color', spotlight: { mode: 'off' } }, REAL)).toEqual([
      { field: 'dayNight', cmd: 'SetIsp', param: { Isp: { channel: 0, dayNight: 'Color' } } },
      { field: 'spotlight', cmd: 'SetWhiteLed', param: { WhiteLed: { channel: 0, mode: 0, bright: 100 } } },
      {
        field: 'osd',
        cmd: 'SetOsd',
        param: { Osd: { channel: 0, osdChannel: { enable: 1, name: 'Porch', pos: 'Lower Right' }, osdTime: { enable: 1, pos: 'Top Center' } } },
      },
    ]);
  });

  // A partial save must never rewrite a field the user didn't touch, even one
  // imageFrom() can't represent (it would read as "Upper Left" / "off" / 0).
  it('copies untouched values from the raw replies, not from the normalized settings', () => {
    const raw = {
      wl: { WhiteLed: { channel: 0, mode: 5, state: 0 } },
      osd: { Osd: { channel: 0, osdChannel: { enable: 1, name: 'Den', pos: 'Lower Right' }, osdTime: { enable: 1, pos: 'Custom Pos' } } },
    };
    expect(imageCommands({ osd: { name: 'Porch' } }, raw)).toEqual([
      {
        field: 'osd',
        cmd: 'SetOsd',
        param: { Osd: { channel: 0, osdChannel: { enable: 1, name: 'Porch', pos: 'Lower Right' }, osdTime: { enable: 1, pos: 'Custom Pos' } } },
      },
    ]);
    expect(imageCommands({ spotlight: { brightness: 40 } }, raw)).toEqual([
      { field: 'spotlight', cmd: 'SetWhiteLed', param: { WhiteLed: { channel: 0, mode: 5, bright: 40 } } },
    ]);
  });

  it('sends nothing for an empty spotlight or OSD patch', () => {
    expect(imageCommands({ spotlight: {}, osd: {} }, REAL)).toEqual([]);
  });

  it('checks each field against the re-read state', () => {
    const reread = detectionFrom(REAL);
    expect(patchApplied('motionSensitivity', { motionSensitivity: 41 }, reread)).toBe(true);
    expect(patchApplied('motionSensitivity', { motionSensitivity: 20 }, reread)).toBe(false);
    expect(patchApplied('ai.person.record', { ai: { person: { record: 'on' } } }, reread)).toBe(true);
    const img = imageFrom(REAL);
    expect(patchApplied('osd', { osd: { name: 'Den' } }, img)).toBe(true);
    expect(patchApplied('spotlight', { spotlight: { mode: 'off' } }, img)).toBe(false);
  });
});
