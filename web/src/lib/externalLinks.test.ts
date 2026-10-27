import { describe, expect, it } from 'vitest';
import { isExternal } from './externalLinks';

describe('isExternal', () => {
  const origin = 'https://cams.skylar.technology';
  it('is true for http(s) links to another origin', () => {
    for (const h of ['https://github.com/klaushofrichter/cams', 'https://skylar.technology', 'https://cams-admin.skylar.technology', 'http://cams.skylar.technology/x']) expect(isExternal(h, origin), h).toBe(true);
  });
  it('is false for same-site links, anchors and other schemes', () => {
    for (const h of ['#open', '/llms.txt', '/signin', '/auth/google/login', 'https://cams.skylar.technology/app', 'mailto:x@example.com']) expect(isExternal(h, origin), h).toBe(false);
  });
});
