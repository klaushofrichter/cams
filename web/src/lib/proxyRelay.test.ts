import { describe, expect, it } from 'vitest';
import { proxyRelayText } from './proxyRelay';

describe('proxyRelayText', () => {
  it('words the shared refusals and leaves the rest to the form', () => {
    expect(proxyRelayText(503, {})).toBe("The camera can't be reached.");
    expect(proxyRelayText(403, { error: 'proxy_admin_missing' })).toBe("cams has no admin token for this proxy: use the proxy's admin page.");
    expect(proxyRelayText(403, { error: 'forbidden' })).toBeNull();
    expect(proxyRelayText(409, { error: 'env_password' })).toBeNull();
  });
});
