// export-config (migration P4, M §11.1): cameras.json without passwords,
// tokens only as SHA-256 hashes, and the stores' counts — the input of
// cams-admin's import (parseCamsExport).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { exportConfig } from '../server/exportConfig';
import { runCli } from '../server/cli';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const PW = 'marker-password-1', TOK = 'marker-token-'.padEnd(40, 't'), ADM = 'marker-admin-'.padEnd(40, 'a');
let dir: string;
const saved: Record<string, string | undefined> = {};
const NAMES = ['CAMERAS_FILE', 'PREFS_FILE', 'PROXY_STATE_FILE', 'PROXY_TLS_FILE'] as const;
beforeEach(() => {
  for (const n of NAMES) saved[n] = process.env[n];
  dir = mkdtempSync(join(tmpdir(), 'cams-export-'));
  process.env.CAMERAS_FILE = join(dir, 'cameras.json');
  process.env.PREFS_FILE = join(dir, 'prefs.json');
  process.env.PROXY_STATE_FILE = join(dir, 'proxy-state.json');
  process.env.PROXY_TLS_FILE = join(dir, 'proxy-tls.json');
  writeFileSync(process.env.CAMERAS_FILE, JSON.stringify([
    { id: 'cam1', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.example.net', user: 'cams', password: PW, webUiUrl: null, proxy: { url: 'https://pi.example:8443/', token: TOK, adminToken: ADM, camera: 'cam1', caFingerprint: ['ab'.repeat(32)], tlsServername: 'pi.example' } },
    { id: 'shed', name: 'Shed', host: '192.0.2.9', protocol: 'http', user: 'u', password: PW, webUiNote: 'sim' },
  ]), { mode: 0o600 });
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe('exportConfig', () => {
  it('no marker; tokens as hashes; every other field equal; counts from the old layout', () => {
    writeFileSync(process.env.PREFS_FILE!, JSON.stringify({ 'a@example.org': {}, 'b@example.org': {} }));
    writeFileSync(process.env.PROXY_STATE_FILE!, JSON.stringify({ cam1: false }));
    writeFileSync(process.env.PROXY_TLS_FILE!, JSON.stringify({ cas: { x: 'pem' }, pins: { cam1: {}, shed: {} } }), { mode: 0o600 });
    const out = exportConfig(() => 1_800_000_000_000, '2026.10.07.1');
    expect(JSON.stringify(out)).not.toContain('marker');
    expect(out).toEqual({
      v: 1, kind: 'cams-export', exportedAt: 1_800_000_000_000, camsVersion: '2026.10.07.1', source: 'cameras-file',
      cameras: [
        { id: 'cam1', name: 'Den', host: 'from-proxy', protocol: 'https', tlsServername: 'cam1.example.net', user: 'cams', webUiUrl: null, proxy: { url: 'https://pi.example:8443', token: { sha256: sha(TOK) }, adminToken: { sha256: sha(ADM) }, camera: 'cam1', caFingerprint: ['ab'.repeat(32)], tlsServername: 'pi.example' } },
        { id: 'shed', name: 'Shed', host: '192.0.2.9', protocol: 'http', user: 'u', webUiNote: 'sim' },
      ],
      counts: { preferencesUsers: 2, proxySwitchOff: 1, tlsCas: 1, tlsPins: 2 },
    });
  });

  it('counts from the account layout', () => {
    writeFileSync(process.env.PREFS_FILE!, JSON.stringify({ v: 2, accounts: { acc_A: { name: 'home', data: { 'a@example.org': {} } }, acc_B: { name: 'b', data: { 'a@example.org': {}, 'c@example.org': {} } } } }));
    writeFileSync(process.env.PROXY_STATE_FILE!, JSON.stringify({ v: 2, accounts: { acc_A: { name: 'home', data: { cam1: false, shed: false } } } }));
    expect(exportConfig(() => 1, 'v').counts).toEqual({ preferencesUsers: 3, proxySwitchOff: 2, tlsCas: 0, tlsPins: 0 });
  });

  it('the CLI prints it (2-space JSON); exit 2 without CAMERAS_FILE', async () => {
    const out: string[] = [], err: string[] = [];
    const io = { stdin: Readable.from([]), out: (l: string) => out.push(l), err: (l: string) => err.push(l), env: process.env };
    expect(await runCli(['export-config'], io)).toBe(0);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.kind).toBe('cams-export');
    expect(out.join('\n')).toContain('\n  "v": 1');
    expect(out.join('\n')).not.toContain('marker');
    delete process.env.CAMERAS_FILE;
    expect(await runCli(['export-config'], { ...io, env: process.env })).toBe(2);
  });
});
