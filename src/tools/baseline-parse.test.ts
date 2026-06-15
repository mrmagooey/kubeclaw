import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { parseToolCatalog } from './types.js';

describe('rendered Helm tools baseline', () => {
  it('parses cleanly via parseToolCatalog', () => {
    const values = parseYaml(
      readFileSync('helm/kubeclaw/values.yaml', 'utf-8'),
    ) as { tools?: unknown[] };
    const envelope = JSON.stringify({
      version: 1,
      generation: 0,
      tools: values.tools ?? [],
    });
    const r = parseToolCatalog(envelope);
    expect(r.ok).toBe(true);
    if (!r.ok) return; // narrow; the expect above already failed the test
    const names = r.tools.map((t) => t.name).sort();
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('browser');
    expect(names).toContain('bash');
    expect(names).toContain('places_search');
  });
});
