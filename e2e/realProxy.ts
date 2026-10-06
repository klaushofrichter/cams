// e2e: the real cam-proxy (its released container image, CAM_PROXY_IMAGE) for
// Silo and Loft, two cameras on one host (cam-proxy spec 2026-10-05
// multi-camera), whose cam-sims refuse HTTP Download: the proxy fetches
// recordings over Baichuan (spec 2026-10-02-recordings-via-proxy-design). Host
// networking, because cam-sim listens on 127.0.0.1 only; the proxy then
// listens on every interface, so this runs on GitHub Actions or with
// CAMS_E2E_REAL_PROXY=1, on Linux only (REAL_PROXY_ON in e2e/env.ts), never on
// the home LAN. It refuses to start otherwise.
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CAM_PROXY_IMAGE, REAL_PROXY, REAL_PROXY_ON } from './env';
import { SIMS } from './sims';

if (!REAL_PROXY_ON) {
  console.error(
    'e2e/realProxy.ts: refusing to start the real cam-proxy. It uses host networking and listens on every ' +
      'interface, so it runs only on Linux with GITHUB_ACTIONS=true or CAMS_E2E_REAL_PROXY=1 (e2e/env.ts).',
  );
  process.exit(1);
}

const NAME = 'cams-e2e-cam-proxy';
const IMAGE = CAM_PROXY_IMAGE;
const s = SIMS.silo;
const l = SIMS.loft;
const dir = mkdtempSync(join(tmpdir(), 'cams-e2e-camproxy-'));
writeFileSync(
  join(dir, 'config.json'),
  JSON.stringify({
    server: { port: REAL_PROXY.port, dataDir: '/data', logLevel: 'warn' },
    // cam-proxy's multi-camera list (its spec 2026-10-05 §4.1), in this order.
    cameras: [
      { id: 'silo', name: 'Silo', host: `127.0.0.1:${s.http}`, protocol: 'http', user: 'e2e', onvifPort: s.onvif, rtspPort: s.rtsp, baichuanPort: s.baichuan, statusPollS: 5 },
      { id: 'loft', name: 'Loft', host: `127.0.0.1:${l.http}`, protocol: 'http', user: 'e2e', onvifPort: l.onvif, rtspPort: l.rtsp, baichuanPort: l.baichuan, statusPollS: 5 },
    ],
    go2rtc: { rtspPort: REAL_PROXY.go2rtcRtsp, apiPort: REAL_PROXY.go2rtcApi },
    stills: { enabled: false },
    ftp: { enabled: false },
  }),
);

spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }); // one left over from an earlier run
const child = spawn(
  'docker',
  [
    'run', '--rm', '--name', NAME, '--network', 'host',
    // The data folder belongs to the runner's user, not the image's uid 1000.
    '--user', `${process.getuid!()}:${process.getgid!()}`,
    '-v', `${dir}:/data`,
    '-e', 'CAMPROXY_CONFIG=/data/config.json',
    '-e', `CAMPROXY_TOKENS=${REAL_PROXY.token}`,
    '-e', `CAMPROXY_ADMIN_TOKEN=${REAL_PROXY.adminToken}`,
    '-e', 'CAMPROXY_CAMERA_PASSWORD=e2e-not-a-real-password',
    IMAGE,
  ],
  { stdio: 'inherit' },
);
const stop = () => {
  spawnSync('docker', ['stop', '-t', '5', NAME], { stdio: 'ignore' });
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 1));
