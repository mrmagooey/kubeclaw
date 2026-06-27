import { draftToolSpec } from './draft.js';

const md = { repo: 'someuser/exiftool', digest: 'sha256:abc', labels: {}, readme: 'exiftool reads EXIF' };

describe('draftToolSpec', () => {
  it('produces a digest-pinned, valid spec', async () => {
    const chat = async () =>
      JSON.stringify({
        name: 'extract_metadata', description: 'Extract EXIF metadata',
        parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
        image: 'someuser/exiftool:latest', pattern: 'file', mount: 'group',
        run: 'exiftool "$(cat "$INPUT_DIR/filename")"',
      });
    const r = await draftToolSpec({ taskDescription: 'exif', metadata: md, chat });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.image).toBe('someuser/exiftool@sha256:abc'); // pinned to digest
  });

  it('fails when no digest is available', async () => {
    const chat = async () => JSON.stringify({ name: 'x', description: 'd', parameters: { type: 'object' }, image: 'x:latest', pattern: 'file' });
    const r = await draftToolSpec({ taskDescription: 't', metadata: { ...md, digest: null }, chat });
    expect(r.ok).toBe(false);
  });

  it('fails when the draft is not a valid ToolSpec', async () => {
    const chat = async () => JSON.stringify({ name: 'BAD NAME!!', description: 'd', parameters: {}, image: 'x', pattern: 'nope' });
    const r = await draftToolSpec({ taskDescription: 't', metadata: md, chat });
    expect(r.ok).toBe(false);
  });
});
