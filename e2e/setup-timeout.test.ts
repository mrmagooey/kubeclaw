import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('e2e/setup.ts configuration', () => {
  it('beforeAll timeout must be >= 180000ms to cover worst-case Redis retry budget', () => {
    const setupSrc = readFileSync(join(__dirname, 'setup.ts'), 'utf8');
    // Match the closing }, <timeout>); of the top-level beforeAll.
    // The regex captures the numeric literal used as the per-call timeout.
    const match = setupSrc.match(/beforeAll\(async \(\) => \{[\s\S]*?\},\s*(\d+)\s*\);/);
    expect(match, 'Could not find beforeAll timeout literal in e2e/setup.ts').toBeTruthy();
    const timeout = Number(match![1]);
    expect(timeout).toBeGreaterThanOrEqual(180000);
  });
});
