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
          parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
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
});
