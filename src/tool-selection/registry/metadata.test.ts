import { fetchImageMetadata } from './metadata';

describe('fetchImageMetadata', () => {
  it('extracts digest and readme', async () => {
    const fetchJson = async (url: string) => {
      if (url.includes('/tags/'))
        return { images: [{ digest: 'sha256:abc123' }] };
      return { full_description: 'Use exiftool to read EXIF.' };
    };
    const md = await fetchImageMetadata(
      'someuser/exiftool',
      'latest',
      fetchJson,
    );
    expect(md.digest).toBe('sha256:abc123');
    expect(md.readme).toContain('EXIF');
  });

  it('tolerates missing digest', async () => {
    const fetchJson = async () => ({});
    const md = await fetchImageMetadata('x/y', 'latest', fetchJson);
    expect(md.digest).toBeNull();
  });
});
