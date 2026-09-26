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
  // The firmware resets keys a Set leaves out (measured 2026-09-26), so every
  // write carries the camera's complete current object with only the changed
  // keys replaced — including keys cams doesn't model (rotation, stay_time,
  // watermark, LightingSchedule, …).
  const FULL = {
    rec: { Rec: { enable: 1, postRec: '15 Seconds', preRec: 1, saveDay: 7, schedule: { channel: 0, table: { MD: ALL, AI_PEOPLE: ALL, AI_VEHICLE: ALL, AI_DOG_CAT: ALL, TIMING: NONE } } } },
    md: { MdAlarm: { channel: 0, useNewSens: 1, newSens: { sensDef: 10, sens: [{ id: 0, sensitivity: 10 }] }, scope: { cols: 70 } } },
    ai: {
      person: { AiAlarm: { channel: 0, ai_type: 'people', sensitivity: 60, stay_time: 3, scope: { area: '11' } } },
      vehicle: { AiAlarm: { channel: 0, ai_type: 'vehicle', sensitivity: 50, stay_time: 0 } },
      pet: { AiAlarm: { channel: 0, ai_type: 'dog_cat', sensitivity: 40, stay_time: 0 } },
    },
    isp: { Isp: { channel: 0, dayNight: 'Auto', antiFlicker: '60HZ', rotation: 0, mirroring: 0, bd_day: { mode: 'Auto' } } },
    ir: { IrLights: { state: 'Auto' } },
    wl: { WhiteLed: { channel: 0, mode: 5, bright: 100, state: 0, LightingSchedule: { StartHour: 18 } } },
    osd: { Osd: { channel: 0, osdChannel: { enable: 1, name: 'Den', pos: 'Lower Right' }, osdTime: { enable: 1, pos: 'Custom Pos' }, watermark: 1, bgcolor: 0 } },
  };

  it('writes the complete current object with only the changed keys replaced', () => {
    expect(imageCommands({ dayNight: 'color', osd: { name: 'Porch' }, spotlight: { brightness: 40 } }, FULL)).toEqual([
      { fields: ['dayNight'], cmd: 'SetIsp', param: { Isp: { ...FULL.isp.Isp, dayNight: 'Color' } } },
      { fields: ['spotlight'], cmd: 'SetWhiteLed', param: { WhiteLed: { ...FULL.wl.WhiteLed, bright: 40 } } },
      {
        fields: ['osd'],
        cmd: 'SetOsd',
        param: { Osd: { ...FULL.osd.Osd, osdChannel: { enable: 1, name: 'Porch', pos: 'Lower Right' } } },
      },
    ]);
    expect(detectionCommands({ motionSensitivity: 50, ai: { person: { sensitivity: 80 } } }, FULL)).toEqual([
      { fields: ['motionSensitivity'], cmd: 'SetMdAlarm', param: { MdAlarm: { ...FULL.md.MdAlarm, newSens: { ...FULL.md.MdAlarm.newSens, sensDef: 1 } } } },
      { fields: ['ai.person.sensitivity'], cmd: 'SetAiAlarm', param: { AiAlarm: { ...FULL.ai.person.AiAlarm, sensitivity: 80 } } },
    ]);
  });

  it('carries several changes to one camera object in a single write', () => {
    const cmds = detectionCommands({ recording: false, motionRecording: 'off', ai: { vehicle: { record: 'off' } } }, FULL);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].fields).toEqual(['recording', 'motionRecording', 'ai.vehicle.record']);
    expect(cmds[0].param).toEqual({
      Rec: { ...FULL.rec.Rec, enable: 0, schedule: { channel: 0, table: { ...FULL.rec.Rec.schedule.table, MD: NONE, AI_VEHICLE: NONE } } },
    });
  });

  it('never mutates the raw replies it is given', () => {
    const before = JSON.stringify(FULL);
    detectionCommands({ recording: false, motionSensitivity: 20, ai: { pet: { sensitivity: 1, record: 'off' } } }, FULL);
    imageCommands({ dayNight: 'color', irLights: 'off', spotlight: { mode: 'off' }, osd: { showTime: false } }, FULL);
    expect(JSON.stringify(FULL)).toBe(before);
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
