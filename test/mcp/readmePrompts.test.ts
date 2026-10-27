import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// The README's MCP sample prompts name the tools an assistant uses; they must
// be tools the server really has, so the docs can't drift from the code.
const root = resolve(__dirname, '../..');
const toolsDir = join(root, 'server/mcp/tools');
const serverTools = new Set(
  readdirSync(toolsDir)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => [...readFileSync(join(toolsDir, f), 'utf8').matchAll(/^\s+name: '([a-z_]+)',$/gm)].map((m) => m[1])),
);

function samplePrompts(): string[] {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## MCP server'), readme.indexOf('\n## ', readme.indexOf('## MCP server') + 3));
  const start = section.indexOf('**Sample prompts**');
  expect(start, 'a "Sample prompts" list in the MCP server section').toBeGreaterThan(0);
  const lines = section.slice(start).split('\n').slice(1);
  const end = lines.findIndex((l) => !/^\s{2,}- /.test(l));
  return lines.slice(0, end === -1 ? undefined : end);
}

describe('README MCP sample prompts', () => {
  it('the server has the tools we expect to find', () => {
    expect(serverTools.size).toBeGreaterThanOrEqual(10);
    expect(serverTools.has('list_cameras')).toBe(true);
  });

  it('lists prompts, each naming tools the server has', () => {
    const prompts = samplePrompts();
    expect(prompts.length).toBeGreaterThanOrEqual(7);
    for (const line of prompts.filter((l) => l.includes('→'))) {
      const tools = [...line.split('→')[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
      expect(tools.length, line).toBeGreaterThan(0);
      for (const t of tools) expect(serverTools.has(t), `${t} in: ${line}`).toBe(true);
    }
  });

  it('says that write requests are declined', () => {
    expect(samplePrompts().join('\n')).toMatch(/read-only/);
  });
});
