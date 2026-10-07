// The source scan of M §9.6, the second net after the compiler: a route
// reads a camera id from the URL only on a marked resolution line, and no
// route calls an all-accounts function of the registry or the stores.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = join(__dirname, '../server/routes');
const ROUTES = readdirSync(DIR).filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(join(DIR, f), 'utf8')] as const);
const SERVER = join(__dirname, '../server');

describe('isolation source scan', () => {
  it('every read of req.params.id / req.params.via is a resolution line marked "// isolation-ok: <why>"', () => {
    const marked: string[] = [];
    for (const [f, src] of ROUTES) {
      src.split('\n').forEach((line, i) => {
        if (/req\.params\.(id|via)\b|req\.params\[['"](id|via)['"]\]|\{\s*(id|via)\s*\}\s*=\s*req\.params/.test(line)) {
          expect(`${f}:${i + 1} ${line}`).toMatch(/\/\/ isolation-ok: \S/);
          marked.push(f);
        }
      });
    }
    // knownCamera (common.ts), proxyOf and itemId (archive.ts): exactly these.
    expect(marked.sort()).toEqual(['archive.ts', 'archive.ts', 'common.ts']);
  });

  it('no route calls an all-accounts registry or store function', () => {
    for (const [f, src] of ROUTES) expect(src, f).not.toMatch(/\b(allCameras|listProxied)\(\s*\)|\bproxyStates\(\s*\)|\barchiveProxies\(\s*\)|\bproxyGroups\(\s*\)|\bfleetCameras\(\s*\)|\bgetCamera\(\s*String\(req/);
  });

  it('every exported registry and store function that takes a camera takes a CamKey', () => {
    // Exported functions whose first parameter names a camera (a CamKey, or a
    // CameraConfig, whose id is one).
    const files = ['cameraRegistry.ts', 'proxyState.ts', 'tls/store.ts', 'tls/cameraTrust.ts', 'reolink/clients.ts', 'proxy/client.ts', 'proxy/groups.ts', 'proxy/names.ts', 'proxy/stream.ts', 'proxy/cameraList.ts', 'recordings/extent.ts', 'recordings/proxyClips.ts', 'recordings/proxyRecordings.ts', 'recordings/detection.ts'];
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(SERVER, f), 'utf8');
      for (const m of src.matchAll(/export (?:async )?(?:function|const) (\w+)\s*=?\s*\(?\s*(\w+)\s*:\s*([\w<>[\] |]+)/g)) {
        const [, name, param, type] = m;
        if (/^(id|cam|cameraId|key)$/.test(param) && !/\b(CamKey|CameraConfig)\b/.test(type)) bad.push(`${f} ${name}(${param}: ${type})`);
      }
    }
    expect(bad).toEqual([]);
  });
});
