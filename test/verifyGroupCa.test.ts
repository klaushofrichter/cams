// verifyGroupCa: ensureGroupCa for callers that go on without the CA.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../server/logger';
import type { ProxyGroup } from '../server/proxy/groups';
import { verifyGroupCa } from '../server/tls/groupCa';
import { loadTlsState } from '../server/tls/store';

const group = (url: string): ProxyGroup => ({ key: 'g', accountId: 'a', url, token: 't', members: [], remoteOf: new Map(), pins: ['ab'.repeat(32)], tlsServername: null });

beforeEach(() => {
  process.env.PROXY_TLS_FILE = join(mkdtempSync(join(tmpdir(), 'cams-vgca-')), 'proxy-tls.json');
  loadTlsState();
});
afterEach(() => vi.restoreAllMocks());

describe('verifyGroupCa', () => {
  it('resolves when the CA cannot be fetched, and warns with the proxy host only', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await expect(verifyGroupCa(group('http://127.0.0.1:1'))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, event] = warn.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(event).toBe('proxy_site_ca_unverified');
    expect(fields.proxy).toBe('127.0.0.1:1');
    expect(typeof fields.message).toBe('string');
  });
  it('asks nothing for a proxy without pins', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await expect(verifyGroupCa({ ...group('http://127.0.0.1:1'), pins: null })).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
