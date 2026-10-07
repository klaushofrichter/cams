// The cams side of the cut-over rehearsal (cams-admin runbook §R step 4,
// M §11.3, §14.5) on cams-admin's local stack (its scripts/localstack/
// start.sh: cams-admin, real cam-proxies, cam-sims, all on 127.0.0.1).
// Two real cams processes from this repo's build, "cluster" (both proxies of
// the account) and "pi" (the first proxy over a loopback-style route; the
// other unrouted: default-deny), go through cut-over steps 5–8:
//   1. P2 managed tokens (steps 1–2) and the two cameras.json files.
//   2. export-config (cams's own CLI): no password, token hashes.
//   3. instances created; admin-enroll (cams's own CLI, the code on stdin).
//   4. imports: dry run, apply, again = no changes (the Pi file: hideUnlisted).
//   5. shadow: both cams report 0 differences ("zero since" set); rollback
//      (file) and back.
//   6. cams-admin mode: the same cameras, the Pi only its own; own tokens
//      registered and active (managed 4 on the cluster), legacy 0.
//   7. offline: cams-admin unreachable (CAMS_ADMIN_URL on a closed port),
//      both restart from the signed cache and serve their cameras.
//   8. Rotate now with a request loop on the cluster cams: 0 failures.
//   9. a held change (a camera's host) confirmed by an admin.
//  10. rollback of the switch: file mode keeps what users changed.
// PASS/FAIL per step, result.json in --work. Never prints a token or a password.
//   npx tsx scripts/livestack/rehearse-cutover.ts --url http://localhost:29000 \
//     --session-file <ls>/run/cams-admin/cookie --run <ls>/run --account beta --work <dir>
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const args = process.argv.slice(2);
const opt = (n: string, def?: string) => {
  const i = args.indexOf(`--${n}`);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  if (def !== undefined) return def;
  throw new Error(`--${n} is required`);
};
const url = opt('url').replace(/\/+$/, '');
const cookie = readFileSync(opt('session-file'), 'utf8').trim();
const runDir = opt('run');
const accountName = opt('account', 'beta');
const work = resolve(opt('work'));
const REPO = resolve(__dirname, '../..');
mkdirSync(work, { recursive: true, mode: 0o700 });

const steps: { step: string; ok: boolean; detail: string }[] = [];
const record = (step: string, ok: boolean, detail = '') => {
  steps.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`step failed: ${step}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | false | undefined>, ms = 90_000): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() - t > ms) throw new Error(`timeout: ${what}`);
    await sleep(500);
  }
}
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${url}/api/v1${path}`, { method, headers: { Cookie: `__Host-cams_admin=${cookie}`, 'X-Cams-Admin': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${j.error ?? ''}${j.field ? ` (${j.field})` : ''}`);
  return j;
}
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const write600 = (f: string, v: unknown) => writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });

const children: Cams[] = []; // stopped (by PID) whatever happens

// --- a cams process ---------------------------------------------------------------
interface Cams { name: string; port: number; dir: string; camerasFile: string; token: string; proc?: ChildProcess; jar: string }
const LOGIN = (n: string) => `rehearsal-${n}-login-token-not-a-secret`.padEnd(40, '0');
function camsEnv(c: Cams, mode: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(c.port), COOKIE_SECRET: `rehearsal-cookie-secret-${c.name}-000000`, COOKIE_SECURE: 'false',
    CAMS_LOGIN_TOKEN: c.token, CAMS_TOKEN_ACCOUNT: accountName, CAMS_FILE_ACCOUNT: accountName,
    CONFIG_SOURCE: mode, CAMS_DATA_DIR: c.dir, CAMERAS_FILE: c.camerasFile, PREFS_FILE: join(c.dir, 'prefs.json'), PROXY_STATE_FILE: join(c.dir, 'proxy-state.json'),
    CACHE_DIR: join(c.dir, 'cache'), CAMS_ADMIN_PULL_MS: '2000', RATE_LIMIT_API_MAX: '100000', RATE_LIMIT_MAX: '100000', LOG_LEVEL: 'info', APP_VERSION: 'rehearsal', ...extra,
  };
}
async function startCams(c: Cams, mode: string, extra: Record<string, string> = {}) {
  await stopCams(c);
  c.proc = spawn('node', [join(REPO, 'dist/server/server.js')], { env: camsEnv(c, mode, extra), stdio: ['ignore', 'pipe', 'pipe'] });
  const log = join(work, `cams-${c.name}.log`);
  c.proc.stdout!.on('data', (d) => writeFileSync(log, d, { flag: 'a', mode: 0o600 }));
  c.proc.stderr!.on('data', (d) => writeFileSync(log, d, { flag: 'a', mode: 0o600 }));
  await until(`cams ${c.name} up`, async () => (await fetch(`http://127.0.0.1:${c.port}/health`)).ok, 30_000);
  const r = await fetch(`http://127.0.0.1:${c.port}/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: c.token }) });
  if (!r.ok) throw new Error(`cams ${c.name}: token sign-in ${r.status}`);
  c.jar = (r.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
}
async function stopCams(c: Cams) {
  const p = c.proc;
  if (!p || p.exitCode !== null || !p.pid) return;
  process.kill(p.pid, 'SIGTERM'); // our own child, by its PID
  await until(`cams ${c.name} stopped`, async () => p.exitCode !== null || p.signalCode !== null, 15_000);
}
async function camsGet<T>(c: Cams, path: string): Promise<{ status: number; body: T }> {
  const r = await fetch(`http://127.0.0.1:${c.port}${path}`, { headers: { Cookie: c.jar, Accept: 'application/json' } });
  const text = await r.text();
  let body: T | null = null;
  try {
    body = (text ? JSON.parse(text) : null) as T;
  } catch {
    body = null; // e.g. a rate limiter's plain text
  }
  return { status: r.status, body: body as T };
}
async function camsSend<T>(c: Cams, method: string, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`http://127.0.0.1:${c.port}${path}`, { method, headers: { Cookie: c.jar, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
}
const camList = async (c: Cams) => (await camsGet<{ id: string; name: string; proxy: boolean }[]>(c, '/api/cameras')).body;
const allOnline = async (c: Cams) => {
  for (const cam of await camList(c)) if (!(await camsGet<{ online: boolean }>(c, `/api/cameras/${cam.id}/status`)).body.online) return false;
  return true;
};
const cli = (c: Cams, argv: string[], stdin = '') =>
  spawnSync('node', [join(REPO, 'dist/server/cli.js'), ...argv], { env: camsEnv(c, 'file'), input: stdin, encoding: 'utf8' });

async function main() {
  const accounts = (await api('GET', '/accounts')).items as any[];
  const account = accounts.find((a) => a.name === accountName) ?? (() => { throw new Error(`no account ${accountName}`); })();
  const proxies = ((await api('GET', `/accounts/${account.id}/proxies`)).items as any[]).sort((a, b) => a.name.localeCompare(b.name));
  const regCams = (await api('GET', `/accounts/${account.id}/cameras`)).items as any[];
  if (proxies.length < 2) throw new Error(`account ${accountName} needs two proxies`);
  const [first, second] = proxies;
  const run = Date.now().toString(36).slice(-4);

  // 1. P2 managed tokens; cameras.json for both cams (passwords: the cam-sims' "cams" user).
  const issue = async (px: any, kind: 'client' | 'admin', label: string) => {
    const t = await api('POST', `/accounts/${account.id}/proxies/${px.id}/tokens`, { kind, label });
    await until(`${label} active`, async () => ((await api('GET', `/accounts/${account.id}/proxies/${px.id}/tokens`)).items as any[]).some((x) => x.id === t.tokenId && x.state === 'active'));
    return t.token as string;
  };
  const tok: Record<string, { client: string; admin: string }> = {};
  for (const px of [first, second]) tok[px.id] = { client: await issue(px, 'client', `cams cluster ${run}`), admin: await issue(px, 'admin', `cams cluster admin ${run}`) };
  const piToken = await issue(first, 'client', `cams pi ${run}`);
  const camsPw = (px: any) => {
    const users = readFileSync(join(runDir, px.name, 'secrets/camsim_users'), 'utf8').trim();
    const e = users.split(';').map((u) => u.split(':')).find((u) => u[0] === 'cams');
    if (!e) throw new Error(`no cams user for ${px.name}`);
    return e[2];
  };
  // The camera's address as its proxy has it (the registry may say "from-proxy",
  // which cams accepts only with https and a TLS name or pin).
  const simHost = (c: any, px: any) => {
    const cfg = JSON.parse(readFileSync(join(runDir, px.name, 'config.json'), 'utf8')) as { cameras: { id: string; host: string }[] };
    const h = cfg.cameras.find((x) => x.id === (c.proxyCameraId ?? c.camsId))?.host;
    if (!h) throw new Error(`no address for ${c.camsId}`);
    return h;
  };
  const fileCam = (c: any, px: any, proxyUrl: string, token: string, admin?: string) => ({
    id: c.camsId, name: c.name, host: simHost(c, px), protocol: 'http' as const, ...(c.tlsServername && { tlsServername: c.tlsServername }), user: 'cams', password: camsPw(px),
    ...(c.webUiUrl !== undefined && c.webUiUrl !== null && { webUiUrl: c.webUiUrl }), ...(c.webUiNote && { webUiNote: c.webUiNote }),
    proxy: { url: proxyUrl, token, ...(admin && { adminToken: admin }), camera: c.proxyCameraId ?? c.camsId },
  });
  const camsOf = (px: any) => regCams.filter((c) => c.proxyId === px.id);
  const mk = (name: string, port: number, list: unknown[]): Cams => {
    const made = mkCams(name, port, list);
    children.push(made);
    return made;
  };
  const mkCams = (name: string, port: number, list: unknown[]): Cams => {
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const camerasFile = join(dir, 'cameras.json');
    write600(camerasFile, list);
    return { name, port, dir, camerasFile, token: LOGIN(name), jar: '' };
  };
  const piUrl = first.url.replace('127.0.0.1', 'localhost');
  const cluster = mk('cluster', 29610, [first, second].flatMap((px) => camsOf(px).map((c) => fileCam(c, px, px.url, tok[px.id].client, tok[px.id].admin))));
  const pi = mk('pi', 29611, camsOf(first).map((c) => fileCam(c, first, piUrl, piToken)));
  record('1 P2 managed tokens active, cameras.json for both cams', true, `${camsOf(first).length + camsOf(second).length} + ${camsOf(first).length} cameras`);

  // 2. export-config (cams's CLI).
  const exp = (c: Cams) => {
    const r = cli(c, ['export-config']);
    if (r.status !== 0) throw new Error(`export-config ${c.name}: ${r.stderr}`);
    write600(join(work, `export-${c.name}.json`), r.stdout);
    return JSON.parse(r.stdout);
  };
  const ec = exp(cluster), ep = exp(pi);
  const leaked = [ec, ep].some((e) => JSON.stringify(e).includes('"password"')) || [...Object.values(tok).flatMap((t) => [t.client, t.admin]), piToken].some((t) => JSON.stringify([ec, ep]).includes(t));
  record('2 export-config: no password, no token (hashes only)', !leaked && ec.cameras.every((c: any) => /^[0-9a-f]{64}$/.test(c.proxy.token.sha256)));

  // 3. Instances, enrolled by cams's own admin-enroll.
  const inst: Record<string, any> = {};
  for (const c of [cluster, pi]) {
    const i = await api('POST', '/cams-instances', { name: `rh-${c.name}-${run}`, displayName: c.name, accounts: [account.id] });
    const { code } = await api('POST', `/cams-instances/${i.id}/enrollment-codes`, { lifetimeH: 1 });
    const r = cli(c, ['admin-enroll', '--url', url], `${code}\n`);
    if (r.status !== 0 || r.stdout.includes(code)) throw new Error(`admin-enroll ${c.name}: ${r.stderr.trim()}`);
    const fp = (await api('GET', '/cams-instances')).serverKeyFingerprints as string[];
    if (!fp.every((f) => r.stdout.includes(f))) throw new Error('admin-enroll: fingerprint not printed');
    inst[c.name] = i;
  }
  record('3 both cams enrolled with admin-enroll (code on stdin, fingerprint printed)', true);

  // 4. Imports.
  const imp = async (i: any, file: unknown, o: { apply?: boolean; hideUnlisted?: boolean } = {}) => {
    const dry = await api('POST', `/accounts/${account.id}/import`, { instanceId: i.id, file, ...o, apply: false });
    if (!o.apply || dry.noChanges) return dry;
    return api('POST', `/accounts/${account.id}/import`, { instanceId: i.id, file, ...o, apply: true, planId: dry.planId });
  };
  const dc = await imp(inst.cluster, ec);
  record('4a cluster dry run: proxies matched by token, no mismatch', dc.mismatches.length === 0 && dc.changes.filter((c: any) => c.kind === 'proxy-matched' && c.by === 'token').length === 2, `${dc.changes.length} changes`);
  await imp(inst.cluster, ec, { apply: true });
  record('4b cluster applied; again: no changes', (await imp(inst.cluster, ec, { apply: true })).noChanges === true);
  const dp = await imp(inst.pi, ep, { hideUnlisted: true });
  record('4c Pi dry run: matched by token, a loopback route, no mismatch', dp.mismatches.length === 0 && dp.changes.some((c: any) => c.kind === 'route-add'));
  await imp(inst.pi, ep, { hideUnlisted: true, apply: true });
  record('4d Pi applied; again: no changes', (await imp(inst.pi, ep, { hideUnlisted: true, apply: true })).noChanges === true);

  // 5. Shadow (steps 5, 6): 0 differences reported; the rollback (file) and back.
  const live = async (c: Cams) => (await api('GET', `/cams-instances/${inst[c.name].id}`)).live;
  for (const c of [cluster, pi]) await startCams(c, 'shadow');
  for (const c of [cluster, pi]) await until(`${c.name} shadow 0`, async () => { const l = await live(c); return l.report?.mode === 'shadow' && l.report.shadow?.differences === 0 && l.shadowZeroSince; });
  const clusterFile = (await camList(cluster)).map((c) => c.id).sort();
  record('5a shadow: 0 differences on both, "zero since" set; cams serves the file', clusterFile.length === camsOf(first).length + camsOf(second).length && (await allOnline(cluster)));
  await startCams(cluster, 'file');
  record('5b rollback of step 5: file mode serves the same cameras', JSON.stringify((await camList(cluster)).map((c) => c.id).sort()) === JSON.stringify(clusterFile) && (await allOnline(cluster)));
  await startCams(cluster, 'shadow');

  // 6. cams-admin mode (steps 7, 8).
  for (const c of [cluster, pi]) await startCams(c, 'cams-admin');
  const ids = async (c: Cams) => (await camList(c)).map((x) => x.id).sort();
  record('6a cams-admin mode: the cluster serves every camera, the Pi only its proxy\'s (default-deny)',
    JSON.stringify(await ids(cluster)) === JSON.stringify(clusterFile) && JSON.stringify(await ids(pi)) === JSON.stringify(camsOf(first).map((c) => c.camsId).sort()) && (await allOnline(cluster)) && (await allOnline(pi)));
  const me = (await camsGet<{ role: string; account: { name: string }; configSource: string }>(cluster, '/api/me')).body;
  record('6b token sign-in: admin of the account, configSource cams-admin', me.role === 'admin' && me.account.name === accountName && me.configSource === 'cams-admin');
  await until('cluster own tokens active (managed 4, legacy 0)', async () => { const l = await live(cluster); return l.report?.mode === 'cams-admin' && l.report.tokens?.managed === 4 && l.report.tokens?.legacy === 0; }, 120_000);
  for (const c of [cluster, pi]) await startCams(c, 'cams-admin'); // the groups on the own tokens from a fresh start too
  record('6c own tokens: registered as hashes, active, in use (managed 4, legacy 0)', (await allOnline(cluster)) && (await camList(cluster)).every((c) => c.proxy));
  await camsSend(cluster, 'PUT', '/api/preferences', { liveQuality: 'main' });

  // 7. Offline start (cams-admin unreachable): from the signed cache.
  for (const c of [cluster, pi]) await startCams(c, 'cams-admin', { CAMS_ADMIN_URL: 'http://127.0.0.1:9' });
  record('7 cams-admin unreachable: both start from the cache, token sign-in, cameras online',
    JSON.stringify(await ids(cluster)) === JSON.stringify(clusterFile) && (await allOnline(cluster)) && (await allOnline(pi)));
  for (const c of [cluster, pi]) await startCams(c, 'cams-admin');

  // 8. Rotate now with a request loop on the cluster cams. The local stack's
  // proxies are enrolled by cams-admin's bridge, which answers tokens.apply
  // without installing the token on the real cam-proxy: the proxies can't
  // check cams-admin's tokens here, so the loop asks the cameras (cams's own
  // API end to end) and the token switch is checked on cams's side (its
  // tokens.json against the token rows) and in its report.
  let failures = 0, calls = 0, stop = false;
  const loop = (async () => {
    while (!stop) {
      for (const c of await camList(cluster)) {
        const r = await camsGet<{ online: boolean }>(cluster, `/api/cameras/${c.id}/status`);
        calls++;
        if (r.status !== 200 || !r.body?.online) failures++;
      }
      await sleep(1000);
    }
  })().catch(() => {
    failures++;
  });
  const oldIds = new Set(((JSON.parse(readFileSync(join(cluster.dir, 'admin/tokens.json'), 'utf8')).tokens) as { id: string }[]).map((t) => t.id));
  await api('POST', `/cams-instances/${inst.cluster.id}/rotate`, {});
  const rows = async () => (await Promise.all([first, second].map(async (px) => (await api('GET', `/accounts/${account.id}/proxies/${px.id}/tokens`)).items as any[]))).flat().filter((t) => t.holder === inst.cluster.id);
  await until('rotation: new tokens active, old retiring', async () => { const r = await rows(); return r.filter((t) => t.state === 'retiring').length >= 4 && r.filter((t) => t.state === 'active').length >= 4; }, 180_000);
  await until('report after the rotation: managed 4, pending 0, legacy 0', async () => { const l = await live(cluster); return l.report?.tokens?.managed === 4 && l.report.tokens.pending === 0 && l.report.tokens.legacy === 0; }, 60_000);
  await sleep(4000);
  stop = true;
  await loop;
  const r8 = await rows();
  const local = (JSON.parse(readFileSync(join(cluster.dir, 'admin/tokens.json'), 'utf8')).tokens) as { id: string; proxyId: string; kind: string; createdAt: number }[];
  const newest = [first, second].flatMap((px) => (['client', 'admin'] as const).map((k) => local.filter((t) => t.proxyId === px.id && t.kind === k).sort((a, b) => b.createdAt - a.createdAt)[0]));
  const switched = newest.every((t) => t && !oldIds.has(t.id) && r8.find((x) => x.id === t.id)?.state === 'active') && [...oldIds].every((id) => r8.find((x) => x.id === id)?.state === 'retiring');
  record('8 Rotate now: cams made new tokens (hashes only), they are active and in use, the old ones retiring; request loop without failures', switched && failures === 0 && calls > 0, `${calls} calls, ${failures} failures`);

  // 9. A held change: a camera's host moved in cams-admin → held until confirmed.
  const target = camsOf(first)[0];
  const oldHost = simHost(target, first);
  const newHost = oldHost.replace('127.0.0.1', 'localhost');
  const patchHost = async (host: string) => api('PATCH', `/accounts/${account.id}/cameras/${target.id}`, { host, version: (await api('GET', `/accounts/${account.id}/cameras/${target.id}`)).version });
  await patchHost(newHost);
  const held = await until('held change shown', async () => {
    const h = (await camsGet<{ items: { camsId: string; fields: string[]; digest: string; to: { host?: string } }[] }>(cluster, '/api/admin/held')).body.items;
    return h.find((x) => x.camsId === target.camsId && x.fields.includes('host')) ?? null;
  });
  // A stale digest is refused first (Confirm acts only on the offer shown).
  const stale = await camsSend<{ error: string }>(cluster, 'POST', '/api/admin/held/confirm', { items: [{ camsId: target.camsId, digest: '0'.repeat(64) }] });
  if (stale.status !== 409) throw new Error(`a stale confirm answered ${stale.status}`);
  const conf = await camsSend<{ confirmed: string[] }>(cluster, 'POST', '/api/admin/held/confirm', { items: [{ camsId: target.camsId, digest: held.digest }] });
  const after = (await camsGet<{ items: unknown[] }>(cluster, '/api/admin/held')).body.items;
  await until('held reported empty', async () => { const l = await live(cluster); return (l.report?.held ?? []).length === 0; });
  record('9 held change: shown (host), a stale confirm refused, confirmed with the offer shown, reported; the camera still online', held.to.host === newHost && conf.body.confirmed.includes(target.camsId) && after.length === 0 && (await allOnline(cluster)));
  await patchHost(oldHost);
  await until('held back', async () => (await camsGet<{ items: unknown[] }>(cluster, '/api/admin/held')).body.items.length === 1);
  const back = (await camsGet<{ items: { camsId: string; digest: string }[] }>(cluster, '/api/admin/held')).body.items;
  await camsSend(cluster, 'POST', '/api/admin/held/confirm', { items: back.map((x) => ({ camsId: x.camsId, digest: x.digest })) });

  // 10. Rollback of the switch: file mode, preferences kept (R4-10).
  await startCams(cluster, 'file');
  const prefs = (await camsGet<{ liveQuality: string }>(cluster, '/api/preferences')).body;
  record('10 rollback to file mode: cameras online, preferences changed in cams-admin mode kept', prefs.liveQuality === 'main' && (await allOnline(cluster)));
  for (const c of [cluster, pi]) await stopCams(c);
}

main()
  .then(() => {
    write600(join(work, 'result.json'), { at: new Date().toISOString(), url, account: accountName, ok: true, steps });
    console.log(`rehearsal (cams side): PASS (${steps.length} steps), result in ${join(work, 'result.json')}`);
    process.exit(0);
  })
  .catch(async (e) => {
    for (const c of children) await stopCams(c).catch(() => undefined);
    write600(join(work, 'result.json'), { at: new Date().toISOString(), url, account: accountName, ok: false, error: (e as Error).message, steps });
    console.error(`rehearsal (cams side): FAIL: ${(e as Error).message}`);
    process.exit(1);
  });
