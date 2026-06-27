import { describe, it, expect } from 'vitest';
import { matchTool } from './matcher.js';
import type { ToolSpec } from '../tools/types.js';

const specs: ToolSpec[] = [
  { name: 'web_search', description: 'Text web search', parameters: {}, image: 'x', pattern: 'http' },
  { name: 'extract_metadata', description: 'Extract EXIF metadata from an image', parameters: {}, image: 'y', pattern: 'file' },
];

describe('matchTool', () => {
  it('returns the spec the LLM selects', async () => {
    const chat = async () =>
      JSON.stringify({ name: 'extract_metadata', confidence: 0.9, reason: 'EXIF match' });
    const r = await matchTool('get the exif data from a photo', specs, chat);
    expect(r.name).toBe('extract_metadata');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('returns null when the LLM finds no fit', async () => {
    const chat = async () => JSON.stringify({ name: null, confidence: 0, reason: 'no match' });
    const r = await matchTool('play chess', specs, chat);
    expect(r.name).toBeNull();
  });

  it('treats a hallucinated name not in specs as no-match', async () => {
    const chat = async () => JSON.stringify({ name: 'made_up_tool', confidence: 1, reason: 'x' });
    const r = await matchTool('anything', specs, chat);
    expect(r.name).toBeNull();
  });
});
