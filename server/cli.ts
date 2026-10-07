// cams's command line (migration P4):
//   node dist/server/cli.js admin-enroll --url <cams-admin>   (the code on stdin)
//   node dist/server/cli.js export-config                     (stdout: a redacted cameras.json)
// The enrollment code is never an argument (it would sit in the shell
// history and the process list); it is read from stdin, silently on a TTY.
import { dirname } from 'path';
import type { Readable } from 'stream';
import { enroll, EnrollError, enrollUrlOk, normaliseCamsCode } from './admin/enroll';
import { writeKeyFile } from './admin/keyfile';
import { appVersion } from './version';
import { exportConfig } from './exportConfig';

export interface CliIo { stdin: Readable; out: (line: string) => void; err: (line: string) => void; env: NodeJS.ProcessEnv }

const USAGE = 'usage: cli.js admin-enroll --url <cams-admin URL>   (the enrollment code on stdin)';

// One line from stdin (at most 128 characters); on a TTY without echo.
function readLine(stdin: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const tty = stdin as Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => void };
    const raw = !!tty.isTTY && typeof tty.setRawMode === 'function';
    if (raw) tty.setRawMode!(true);
    let buf = '';
    const done = (v: string | Error) => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onEnd);
      if (raw) tty.setRawMode!(false);
      stdin.pause();
      if (v instanceof Error) reject(v);
      else resolve(v);
    };
    const onData = (d: Buffer | string) => {
      for (const ch of d.toString()) {
        if (ch === '\n' || ch === '\r') return done(buf);
        if (ch === '\u0003') return done(new Error('cancelled'));
        buf += ch;
        if (buf.length > 128) return done(new Error('the code is too long'));
      }
    };
    const onEnd = () => done(buf);
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onEnd);
    stdin.resume();
  });
}

async function adminEnroll(args: string[], io: CliIo): Promise<number> {
  let url: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) url = args[++i];
    else {
      io.err(`unknown option ${args[i].startsWith('--') ? args[i] : '(argument)'}; ${USAGE}`);
      return 2;
    }
  }
  if (!url || !/^https?:\/\/[^\s]+$/.test(url)) {
    io.err(USAGE);
    return 2;
  }
  if (!enrollUrlOk(url)) {
    io.err('the cams-admin URL must be https:// (plain http only on localhost)');
    return 2;
  }
  const dir = io.env.CAMS_DATA_DIR || (io.env.PREFS_FILE ? dirname(io.env.PREFS_FILE) : undefined);
  if (!dir) {
    io.err('set CAMS_DATA_DIR (or PREFS_FILE): the key file is written to <data>/admin/key.json');
    return 2;
  }
  let code: string;
  try {
    code = (await readLine(io.stdin)).trim();
  } catch (err) {
    io.err((err as Error).message);
    return 2;
  }
  if (!normaliseCamsCode(code)) {
    io.err('that is not a cams enrollment code (CAC1-…)');
    return 2;
  }
  try {
    const k = await enroll(url, code, appVersion() ?? 'dev');
    writeKeyFile(k, dir);
    io.out(`enrolled as ${k.instanceName} (${k.instanceId}), accounts ${k.accounts.join(', ') || '(none)'}; server key ${k.serverKeyFingerprints.join(', ')} (computed from the key received) — compare it with the instance page in cams-admin before using this instance`);
    return 0;
  } catch (err) {
    io.err(err instanceof EnrollError ? `enrollment refused: ${err.code}` : `enrollment failed: ${(err as Error).message}`);
    return 1;
  }
}

// cameras.json without secrets, for cams-admin's import (M §11.1).
function exportConfigCmd(io: CliIo): number {
  if (!io.env.CAMERAS_FILE) {
    io.err('export-config reads CAMERAS_FILE, which is not set');
    return 2;
  }
  io.out(JSON.stringify(exportConfig(Date.now, appVersion() || 'dev'), null, 2));
  return 0;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'admin-enroll') return adminEnroll(rest, io);
  if (cmd === 'export-config') return exportConfigCmd(io);
  io.err(USAGE);
  return 2;
}

if (require.main === module) {
  void runCli(process.argv.slice(2), { stdin: process.stdin, out: (l) => console.log(l), err: (l) => console.error(l), env: process.env }).then((code) => {
    process.exitCode = code;
  });
}
