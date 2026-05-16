/**
 * Regression test for vitest.e2e.config.ts exclusion globs.
 *
 * Ensures that the e2e config explicitly excludes:
 *   1. e2e/.pre-merge-backup/** — accidentally committed dir, still on disk,
 *      contains zod test files that fail with ERR_MODULE_NOT_FOUND.
 *   2. e2e/minikube-live*.test.ts — dedicated to vitest.minikube-live.config.ts,
 *      bail out with "globalSetup port-forward not live" when run here.
 *
 * A textual check is deliberate: importing a vitest config inside vitest is
 * fragile (circular defineConfig calls), and we care only that the globs are
 * present in source — not that vitest's internal resolver applies them.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const CONFIG_PATH = resolve(__dirname, '../vitest.e2e.config.ts');
const configSource = readFileSync(CONFIG_PATH, 'utf8');

describe('vitest.e2e.config.ts exclusions', () => {
  it('excludes e2e/.pre-merge-backup/**', () => {
    expect(configSource).toMatch(/e2e\/\.pre-merge-backup\/\*\*/);
  });

  it('excludes e2e/minikube-live*.test.ts', () => {
    expect(configSource).toMatch(/e2e\/minikube-live\*\.test\.ts/);
  });
});
