import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ToolCatalogLoader } from './catalog-loader.js';

function wire(tools: unknown[], generation = 1): string {
  return JSON.stringify({ version: 1, generation, tools });
}
const t = (name: string, channels?: string[]) => ({
  name,
  description: 'd',
  parameters: {},
  image: 'img:1',
  pattern: 'http',
  ...(channels ? { channels } : {}),
});

let dir: string | undefined;
let loader: ToolCatalogLoader | undefined;
afterEach(() => {
  loader?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('ToolCatalogLoader', () => {
  it('returns [] when the file is absent', () => {
    dir = mkdtempSync(join(tmpdir(), 'toolcat-'));
    loader = new ToolCatalogLoader(join(dir, 'tools.json'));
    loader.start();
    expect(loader.getAll()).toEqual([]);
  });

  it('loads tools from the file', () => {
    dir = mkdtempSync(join(tmpdir(), 'toolcat-'));
    const p = join(dir, 'tools.json');
    writeFileSync(p, wire([t('a'), t('b')]));
    loader = new ToolCatalogLoader(p);
    loader.start();
    expect(loader.getAll().map((x) => x.name)).toEqual(['a', 'b']);
  });

  it('filters by channel ACL (empty channels = all)', () => {
    dir = mkdtempSync(join(tmpdir(), 'toolcat-'));
    const p = join(dir, 'tools.json');
    writeFileSync(p, wire([t('all'), t('tg', ['telegram']), t('web', ['http'])]));
    loader = new ToolCatalogLoader(p);
    loader.start();
    expect(loader.getForChannel('telegram').map((x) => x.name).sort()).toEqual([
      'all',
      'tg',
    ]);
    expect(loader.getForChannel('http').map((x) => x.name).sort()).toEqual([
      'all',
      'web',
    ]);
  });

  it('keeps the stale cache when the file becomes invalid', () => {
    dir = mkdtempSync(join(tmpdir(), 'toolcat-'));
    const p = join(dir, 'tools.json');
    writeFileSync(p, wire([t('a')]));
    loader = new ToolCatalogLoader(p);
    loader.start();
    expect(loader.getAll()).toHaveLength(1);
    // Force a reload with garbage via the private load path:
    writeFileSync(p, '{ broken');
    (loader as unknown as { load: () => void }).load();
    expect(loader.getAll()).toHaveLength(1); // unchanged
  });
});
