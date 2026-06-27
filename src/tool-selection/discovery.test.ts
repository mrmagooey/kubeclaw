import { makeSearchRegistry } from './discovery.js';

const exifDraft = {
  name: 'extract_metadata',
  description: 'EXIF',
  parameters: {
    type: 'object',
    properties: { filename: { type: 'string' } },
    required: ['filename'],
  },
  image: 'someuser/exiftool:latest',
  pattern: 'file',
  mount: 'group',
  run: 'exiftool "$(cat "$INPUT_DIR/filename")"',
};

describe('makeSearchRegistry', () => {
  it('returns the first candidate that drafts coherently and probes clean', async () => {
    const search = makeSearchRegistry({
      fetchJson: async (url) => {
        if (url.includes('/search/'))
          return {
            results: [
              {
                repo_name: 'someuser/exiftool',
                star_count: 5,
                is_official: false,
              },
            ],
          };
        if (url.includes('/tags/'))
          return { images: [{ digest: 'sha256:abc' }] };
        return { full_description: 'exiftool' };
      },
      chat: async () => JSON.stringify(exifDraft),
      probe: {
        runProbeToolJob: async () => ({ ok: true, output: 'ExifTool 12' }),
      },
      catalogHostLookup: () => undefined,
    });
    const spec = await search('extract exif metadata from an image');
    expect(spec?.name).toBe('extract_metadata');
    expect(spec?.image).toBe('someuser/exiftool@sha256:abc');
  });

  it('returns null when every candidate fails the probe', async () => {
    const search = makeSearchRegistry({
      fetchJson: async (url) => {
        if (url.includes('/search/'))
          return {
            results: [{ repo_name: 'x/y', star_count: 1, is_official: false }],
          };
        if (url.includes('/tags/'))
          return { images: [{ digest: 'sha256:zzz' }] };
        return { full_description: 'thing' };
      },
      chat: async () => JSON.stringify({ ...exifDraft, image: 'x/y:latest' }),
      probe: {
        runProbeToolJob: async () => ({ ok: false, egressViolation: true }),
      },
      catalogHostLookup: () => undefined,
    });
    expect(await search('do a thing')).toBeNull();
  });

  // Multi-candidate fallback: two candidates where the FIRST one fails at a
  // given stage and the loop must continue to the SECOND. searchImages sorts by
  // (official desc, stars desc), so bad/one is given MORE stars to guarantee it
  // is processed first. draftToolSpec force-pins image to `repo@digest`, so the
  // returned spec's image unambiguously identifies which candidate won.
  const goodDraft = {
    name: 'good_tool',
    description: 'a good tool',
    parameters: {
      type: 'object',
      properties: { filename: { type: 'string' } },
      required: ['filename'],
    },
    image: 'good/two:latest',
    pattern: 'file',
    mount: 'group',
    run: 'echo hi',
  };

  const twoCandidateSearch = (url: string) => {
    if (url.includes('/search/'))
      return {
        results: [
          { repo_name: 'bad/one', star_count: 5, is_official: false },
          { repo_name: 'good/two', star_count: 2, is_official: false },
        ],
      };
    if (url.includes('/tags/'))
      return {
        images: [
          { digest: url.includes('good/two') ? 'sha256:good' : 'sha256:bad' },
        ],
      };
    return { full_description: 'thing' };
  };

  it('skips a candidate whose draft fails and returns the next one', async () => {
    const search = makeSearchRegistry({
      fetchJson: async (url) => twoCandidateSearch(url),
      // Unparseable for bad/one, valid JSON for good/two.
      chat: async (messages) => {
        const user = messages.find((m) => m.role === 'user')?.content ?? '';
        return user.includes('good/two') ? JSON.stringify(goodDraft) : 'not-json';
      },
      probe: {
        runProbeToolJob: async () => ({ ok: true, output: 'good output' }),
      },
      catalogHostLookup: () => undefined,
    });
    const spec = await search('do a thing');
    expect(spec?.name).toBe('good_tool');
    expect(spec?.image).toBe('good/two@sha256:good');
  });

  it('skips a candidate whose spec is incoherent and returns the next one', async () => {
    // First candidate's spec is credentialed but declares egress to a host with
    // no matching credential -> checkEgressCredentialCoherence returns ok:false,
    // so it must NOT be probed and the loop continues.
    const incoherentDraft = {
      name: 'incoherent_tool',
      description: 'declares egress to a host with no matching credential',
      parameters: {
        type: 'object',
        properties: { filename: { type: 'string' } },
        required: ['filename'],
      },
      image: 'bad/one:latest',
      pattern: 'file',
      mount: 'group',
      run: 'echo hi',
      credentials: ['some-cred'],
      allowedEgress: [{ host: 'wrong.example.com' }],
    };
    const probedImages: string[] = [];
    const search = makeSearchRegistry({
      fetchJson: async (url) => twoCandidateSearch(url),
      chat: async (messages) => {
        const user = messages.find((m) => m.role === 'user')?.content ?? '';
        return user.includes('good/two')
          ? JSON.stringify(goodDraft)
          : JSON.stringify(incoherentDraft);
      },
      probe: {
        runProbeToolJob: async ({ toolSpec }) => {
          probedImages.push(toolSpec.image);
          return { ok: true, output: 'good output' };
        },
      },
      // Credential resolves to api.example.com, which does not match the
      // declared egress host wrong.example.com -> incoherent.
      catalogHostLookup: (id) =>
        id === 'some-cred' ? 'api.example.com' : undefined,
    });
    const spec = await search('do a thing');
    expect(spec?.name).toBe('good_tool');
    expect(spec?.image).toBe('good/two@sha256:good');
    // The incoherent candidate must never reach the probe.
    expect(probedImages).toEqual(['good/two@sha256:good']);
  });

  it('skips a candidate that throws and returns the next one', async () => {
    // The probe runner throws for the first candidate; discovery's per-candidate
    // try/catch must swallow it and continue rather than aborting the search.
    const search = makeSearchRegistry({
      fetchJson: async (url) => twoCandidateSearch(url),
      chat: async () => JSON.stringify(goodDraft),
      probe: {
        runProbeToolJob: async ({ toolSpec }) => {
          if (toolSpec.image.includes('bad/one'))
            throw new Error('probe infra exploded');
          return { ok: true, output: 'good output' };
        },
      },
      catalogHostLookup: () => undefined,
    });
    const spec = await search('do a thing');
    expect(spec?.name).toBe('good_tool');
    expect(spec?.image).toBe('good/two@sha256:good');
  });
});
