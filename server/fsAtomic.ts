import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { dirname } from 'path';

// Writes a file atomically: its folder made if missing, a temp file next to
// it (a random part, so two writers never share one; `mode` when given),
// synced before the rename so a crash right after can't leave the name
// pointing at data that never reached the disk. A failed write removes the
// temp file and leaves the old file as it was.
export async function writeFileAtomic(file: string, content: string, { mode }: { mode?: number } = {}): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    const fh = await fs.open(tmp, 'wx', mode);
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
