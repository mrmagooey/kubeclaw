import { describe, it, expect } from 'vitest';
import { searchImages } from './search.js';

const fakeResponse = {
  results: [
    { repo_name: 'someuser/exiftool', short_description: 'exif', star_count: 5, is_official: false },
    { repo_name: 'library/alpine', short_description: 'tiny', star_count: 9000, is_official: true },
  ],
};

describe('searchImages', () => {
  it('maps and ranks official/starred images first', async () => {
    const fetchJson = async () => fakeResponse;
    const out = await searchImages('exiftool', fetchJson, 10);
    expect(out[0].repo).toBe('library/alpine'); // official ranks first
    expect(out[1].repo).toBe('someuser/exiftool');
  });

  it('returns [] on a malformed response', async () => {
    const fetchJson = async () => ({});
    expect(await searchImages('x', fetchJson)).toEqual([]);
  });
});
