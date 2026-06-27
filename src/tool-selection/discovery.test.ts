import { makeSearchRegistry } from './discovery.js';

const exifDraft = {
  name: 'extract_metadata', description: 'EXIF',
  parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
  image: 'someuser/exiftool:latest', pattern: 'file', mount: 'group',
  run: 'exiftool "$(cat "$INPUT_DIR/filename")"',
};

describe('makeSearchRegistry', () => {
  it('returns the first candidate that drafts coherently and probes clean', async () => {
    const search = makeSearchRegistry({
      fetchJson: async (url) => {
        if (url.includes('/search/')) return { results: [{ repo_name: 'someuser/exiftool', star_count: 5, is_official: false }] };
        if (url.includes('/tags/')) return { images: [{ digest: 'sha256:abc' }] };
        return { full_description: 'exiftool' };
      },
      chat: async () => JSON.stringify(exifDraft),
      probe: { runProbeToolJob: async () => ({ ok: true, output: 'ExifTool 12' }) },
      catalogHostLookup: () => undefined,
    });
    const spec = await search('extract exif metadata from an image');
    expect(spec?.name).toBe('extract_metadata');
    expect(spec?.image).toBe('someuser/exiftool@sha256:abc');
  });

  it('returns null when every candidate fails the probe', async () => {
    const search = makeSearchRegistry({
      fetchJson: async (url) => {
        if (url.includes('/search/')) return { results: [{ repo_name: 'x/y', star_count: 1, is_official: false }] };
        if (url.includes('/tags/')) return { images: [{ digest: 'sha256:zzz' }] };
        return { full_description: 'thing' };
      },
      chat: async () => JSON.stringify({ ...exifDraft, image: 'x/y:latest' }),
      probe: { runProbeToolJob: async () => ({ ok: false, egressViolation: true }) },
      catalogHostLookup: () => undefined,
    });
    expect(await search('do a thing')).toBeNull();
  });
});
