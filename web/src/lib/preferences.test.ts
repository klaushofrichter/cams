import { describe, expect, it } from 'vitest';
import { startCamera } from './preferences';

// Which camera the app opens on (Klaus, 2026-09-28): a chosen default, else
// the last camera used, else the first one.
describe('startCamera', () => {
  const list = [{ id: 'cam1' }, { id: 'cam2' }];
  it('takes the chosen default, then the last used, then the first', () => {
    expect(startCamera(list, { defaultCamera: 'cam2', lastCamera: 'cam1' })).toBe('cam2');
    expect(startCamera(list, { defaultCamera: null, lastCamera: 'cam2' })).toBe('cam2');
    expect(startCamera(list, { defaultCamera: null, lastCamera: null })).toBe('cam1');
    expect(startCamera(list, null)).toBe('cam1');
  });
  it('ignores cameras that no longer exist', () => {
    expect(startCamera(list, { defaultCamera: 'gone', lastCamera: 'gone' })).toBe('cam1');
    expect(startCamera([], null)).toBeNull();
  });
});
