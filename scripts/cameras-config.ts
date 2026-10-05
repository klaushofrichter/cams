// scripts/cameras-config.ts
// Writes cams's cameras.json from a short list of cam-proxies (cam-proxy
// spec 2026-10-05 §13.3). Dry run by default; --write to write.
//   npx tsx scripts/cameras-config.ts [--output cameras.json] [--input cameras-config.json] [--write] [--prune]
// The input (mode 600, never committed) holds the tokens and passwords, or
// {"env": "NAME"} / {"file": "path"} for each; nothing secret goes on the
// command line, and nothing secret is printed.
import { runCamerasConfig } from '../server/cameraImport';

void runCamerasConfig(process.argv.slice(2), process.env, { out: (l) => console.log(l), err: (l) => console.error(l) }).then((code) => {
  process.exitCode = code;
});
