import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SpecialistCatalogLoader } from './catalog-loader.js';

describe('SpecialistCatalogLoader', () => {
  let dir: string;
  let loader: SpecialistCatalogLoader;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'specialists-'));
  });
  afterEach(() => {
    loader?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty catalog when file is absent', () => {
    loader = new SpecialistCatalogLoader(join(dir, 'specialists.json'));
    loader.start();
    expect(loader.getAll()).toEqual([]);
  });

  it('loads specialists from the file at startup', () => {
    writeFileSync(join(dir, 'specialists.json'),
      JSON.stringify({ version: 1, generation: 1, specialists: [{ name: 'A', prompt: 'p' }] }));
    loader = new SpecialistCatalogLoader(join(dir, 'specialists.json'));
    loader.start();
    expect(loader.getAll()).toHaveLength(1);
    expect(loader.getAll()[0].name).toBe('A');
  });

  it('reloads when the file changes (atomic write)', async () => {
    const path = join(dir, 'specialists.json');
    writeFileSync(path, JSON.stringify({ version: 1, generation: 1, specialists: [{ name: 'A', prompt: 'p' }] }));
    loader = new SpecialistCatalogLoader(path);
    loader.start();
    expect(loader.getAll()[0].name).toBe('A');
    // Atomic write: write to temp then rename
    writeFileSync(path + '.tmp', JSON.stringify({ version: 1, generation: 2, specialists: [{ name: 'B', prompt: 'q' }] }));
    const { renameSync } = await import('fs');
    renameSync(path + '.tmp', path);
    await new Promise(r => setTimeout(r, 150));
    expect(loader.getAll()[0].name).toBe('B');
  });

  it('keeps previous cache when reload encounters invalid JSON', async () => {
    const path = join(dir, 'specialists.json');
    writeFileSync(path, JSON.stringify({ version: 1, generation: 1, specialists: [{ name: 'A', prompt: 'p' }] }));
    loader = new SpecialistCatalogLoader(path);
    loader.start();
    writeFileSync(path, 'not-json');
    await new Promise(r => setTimeout(r, 150));
    expect(loader.getAll()[0].name).toBe('A'); // still A, parse-failure fallback
  });

  it('findByMention matches name and triggers case-insensitively', () => {
    writeFileSync(join(dir, 'specialists.json'), JSON.stringify({
      version: 1, generation: 1,
      specialists: [{ name: 'CodeReview', prompt: 'p', triggers: ['QA'] }],
    }));
    loader = new SpecialistCatalogLoader(join(dir, 'specialists.json'));
    loader.start();
    expect(loader.findByMention('codereview')?.name).toBe('CodeReview');
    expect(loader.findByMention('qa')?.name).toBe('CodeReview');
    expect(loader.findByMention('nope')).toBeUndefined();
  });
});
