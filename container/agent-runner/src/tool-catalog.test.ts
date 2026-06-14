import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadCatalog } from './tool-catalog.js';

function writeCatalog(tools: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'kc-cat-'));
  const path = join(dir, 'tools.json');
  writeFileSync(path, JSON.stringify({ version: 1, generation: 3, tools }));
  return path;
}

describe('loadCatalog', () => {
  it('returns [] when the file is absent', () => {
    const cat = loadCatalog('/no/such/path/tools.json');
    expect(cat.getForChannel('')).toEqual([]);
  });

  it('reads tools and exposes name/description/parameters/timeout', () => {
    const path = writeCatalog([
      {
        name: 'bash',
        description: 'run a command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
        },
        image: 'alpine:latest',
        pattern: 'file',
        run: 'sh -c "$(cat "$INPUT_DIR/command")"',
      },
    ]);
    const cat = loadCatalog(path);
    const tools = cat.getForChannel('');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('bash');
    expect(tools[0].description).toBe('run a command');
    expect(tools[0].parameters).toMatchObject({ type: 'object' });
  });

  it('getForChannel filters by the channels ACL', () => {
    const path = writeCatalog([
      {
        name: 'open',
        description: 'd',
        parameters: { type: 'object' },
        image: 'i',
        pattern: 'file',
      },
      {
        name: 'restricted',
        description: 'd',
        parameters: { type: 'object' },
        image: 'i',
        pattern: 'file',
        channels: ['telegram'],
      },
    ]);
    const cat = loadCatalog(path);
    expect(cat.getForChannel('').map((t) => t.name)).toEqual(['open']);
    expect(
      cat
        .getForChannel('telegram')
        .map((t) => t.name)
        .sort(),
    ).toEqual(['open', 'restricted']);
  });

  it('tolerates an unparseable file by returning []', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kc-cat-'));
    const path = join(dir, 'tools.json');
    writeFileSync(path, 'not json');
    const cat = loadCatalog(path);
    expect(cat.getForChannel('')).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
