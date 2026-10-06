// Chain validation is skipped in one file only (server/tls/leafPin.ts, the
// one CodeQL exception; security review of PR #227). The scan and its own
// check against every known way around it.
import { describe, expect, it } from 'vitest';
import { LEAF_PIN, readSource, sourceFiles, tlsViolations } from './helpers/tlsScan';

describe('TLS without chain validation', () => {
  it('exists only in server/tls/leafPin.ts (server/ and scripts/)', () => {
    const files = sourceFiles();
    expect(files).toContain(LEAF_PIN);
    expect(files).toContain('server/reolink/http.ts');
    expect(files.flatMap((f) => tlsViolations(f, readSource(f)))).toEqual([]);
  });
});

describe('the scan catches', () => {
  const bad = (line: string, rel = 'server/x.ts') => expect(tlsViolations(rel, line), line).not.toEqual([]);
  const ok = (line: string, rel = 'server/x.ts') => expect(tlsViolations(rel, line), line).toEqual([]);

  it('rejectUnauthorized other than exactly true', () => {
    bad('const a = { rejectUnauthorized: false };');
    bad('return { rejectUnauthorized: Boolean(x) };');
    bad('rejectUnauthorized: true && false,');
    bad('rejectUnauthorized: truex,');
    bad('rejectUnauthorized:false');
    bad("o['rejectUnauthorized'] = false;");
    bad('o.rejectUnauthorized = 0;');
    ok('return { ca, rejectUnauthorized: true, servername };');
    ok('connect: { ca: pems, rejectUnauthorized: true }');
  });

  it('a computed or quoted key', () => {
    bad('const o = { ["rejectUn" + "authorized"]: false };');
    bad("const o = { ['reje' + 'ctUnauthorized']: false };");
    bad('const k = "ctUnauthorized";');
  });

  it('checkServerIdentity, NODE_TLS_REJECT_UNAUTHORIZED, tls.connect and the tls module', () => {
    bad('checkServerIdentity: () => undefined,');
    bad("process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';");
    bad('const s = tls.connect({ host, port });');
    bad('const s = tlsConnect(opts);');
    bad("import { connect } from 'node:tls';");
    bad("const tls = require('tls');");
    bad("const tls = await import('node:tls');");
    ok("function tlsOf(v: unknown): ProxyCamera['tls'] {");
  });

  it('leafPin.ts used outside its three files, or an export used by the wrong one', () => {
    bad("import { CA_FETCH_CONNECT } from '../tls/leafPin';", 'server/proxy/client.ts');
    bad('new Agent({ connect: { ...CA_FETCH_CONNECT } })', 'server/reolink/http.ts');
    bad('return { ...LEGACY_UNVERIFIED_CAMERA };', 'server/tls/siteCa.ts');
    bad("import * as lp from './leafPin';", 'server/tls/store.ts');
    ok("import { CA_FETCH_CONNECT } from './leafPin';", 'server/tls/siteCa.ts');
    ok("import { LEGACY_UNVERIFIED_CAMERA, pinnedConnection } from '../tls/leafPin';", 'server/reolink/http.ts');
  });

  it('but not in comment lines, nor in leafPin.ts itself', () => {
    ok('// Node skips checkServerIdentity when the chain fails');
    ok('const socket = tlsConnect({ host, port, rejectUnauthorized: false });', LEAF_PIN);
  });
});
