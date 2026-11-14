import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../server/fsAtomic';

describe('writeFileAtomic', () => {
  it('writes the file (folder made if missing) with the mode given, leaving no temp file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cams-atomic-'));
    const file = join(dir, 'sub', 'state.json');
    await writeFileAtomic(file, '{"a":1}', { mode: 0o600 });
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'sub'))).toEqual(['state.json']);
  });
  it('a failed rename removes the temp file and keeps the old file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cams-atomic-'));
    // A folder where the file should be: the rename fails.
    const file = join(dir, 'state.json');
    mkdirSync(file);
    writeFileSync(join(file, 'keep'), 'x');
    await expect(writeFileAtomic(file, 'new')).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['state.json']);
    expect(readFileSync(join(file, 'keep'), 'utf8')).toBe('x');
  });
});
