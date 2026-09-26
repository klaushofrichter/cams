import { describe, expect, it } from 'vitest';
import { deriveStatus, documentTitle, faviconSvg } from './liveStatus';

const base = { mounted: true, cameraName: 'Den', online: true, offlineReason: null, player: 'playing' as const };

describe('deriveStatus', () => {
  it('is streaming while the live picture plays', () => {
    expect(deriveStatus(base)).toEqual({ state: 'streaming', cameraName: 'Den', detail: 'Den: live video is streaming' });
  });

  it('is an error while reconnecting or when the camera is offline', () => {
    expect(deriveStatus({ ...base, player: 'reconnecting' })).toMatchObject({ state: 'error', detail: 'Den: connection lost, reconnecting…' });
    expect(deriveStatus({ ...base, online: false, player: null, offlineReason: 'The camera is not reachable.' })).toMatchObject({
      state: 'error',
      detail: 'Den: offline. The camera is not reachable.',
    });
  });

  it('is idle while connecting for the first time, and when Live is not running', () => {
    expect(deriveStatus({ ...base, player: 'connecting' })).toMatchObject({ state: 'idle', detail: 'Den: connecting…' });
    expect(deriveStatus({ ...base, mounted: false })).toEqual({ state: 'idle', cameraName: null, detail: 'No live video' });
  });
});

describe('outputs', () => {
  it('frames the favicon in green or red, and not at all when idle', () => {
    expect(faviconSvg('streaming')).toContain('stroke="#22C55E"');
    expect(faviconSvg('error')).toContain('stroke="#EF4444"');
    expect(faviconSvg('idle')).not.toMatch(/#22C55E|#EF4444/);
  });

  it('puts the status in the tab title', () => {
    expect(documentTitle({ state: 'streaming', cameraName: 'Den', detail: '' })).toBe('● Live · Den · cams');
    expect(documentTitle({ state: 'error', cameraName: 'Den', detail: '' })).toBe('⚠ Den · cams');
    expect(documentTitle({ state: 'idle', cameraName: null, detail: '' })).toBe('cams · Skylar Technology');
  });
});
