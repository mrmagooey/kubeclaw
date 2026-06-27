import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolLibraryLoader } from './library';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lib-'));
  const path = join(dir, 'library.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      generation: 1,
      tools: [
        {
          name: 'extract_metadata',
          description: 'Extract EXIF metadata from an image file',
          parameters: {
            type: 'object',
            properties: { filename: { type: 'string' } },
            required: ['filename'],
          },
          image: 'kubeclaw/exiftool:latest',
          pattern: 'file',
          mount: 'group',
          run: 'exiftool "$(cat "$INPUT_DIR/filename")"',
        },
      ],
    }),
  );
  return path;
}

describe('ToolLibraryLoader', () => {
  it('loads library specs from disk', () => {
    const loader = new ToolLibraryLoader(fixture());
    loader.start();
    const all = loader.getAll();
    expect(all.map((t) => t.name)).toEqual(['extract_metadata']);
    loader.stop();
  });

  it('returns empty when the file is absent', () => {
    const loader = new ToolLibraryLoader('/nonexistent/library.json');
    loader.start();
    expect(loader.getAll()).toEqual([]);
    loader.stop();
  });

  it('keeps the existing cache when a reload fails to parse', () => {
    const path = fixture();
    const loader = new ToolLibraryLoader(path);
    loader.start();
    expect(loader.getAll()).toHaveLength(1);

    // Clobber the file with invalid content, then trigger a reload directly
    // (avoid the fs.watch timer, which is timing-flaky).
    writeFileSync(path, '{ not valid json');
    (loader as unknown as { load(): void }).load();

    const all = loader.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('extract_metadata');
    loader.stop();
  });
});
