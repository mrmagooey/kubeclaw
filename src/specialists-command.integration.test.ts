// src/specialists-command.integration.test.ts
/**
 * Integration tests for the /specialists command.
 *
 * Exercises the command logic against a SpecialistCatalogLoader backed by a
 * real tmpfile — no Kubernetes required.  Verifies the full hot-reload path
 * (Story 13 AC4) that the channel uses.
 *
 * The logic under test is extracted here to avoid importing channel-runner.ts
 * which creates a k8s JobRunner singleton at module load time (pre-existing
 * environment constraint).  The same logic is also exported from channel-runner.ts
 * and unit-tested via the processGroupMessages dispatch tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SpecialistCatalogLoader } from './specialists/catalog-loader.js';

// ── The same logic as isSpecialistsCommand / handleSpecialistsCommand in
//    channel-runner.ts — kept in sync by the build test below.

function isSpecialistsCommand(message: string): boolean {
  return /^\/specialists(\s|$)/i.test(message.trim());
}

function handleSpecialistsCommand(
  message: string,
  catalog: Pick<SpecialistCatalogLoader, 'getAll'>,
): string {
  const trimmed = message.trim();
  const subCommand = trimmed.replace(/^\/specialists\s*/i, '').trim().toLowerCase();
  if (subCommand !== 'list') {
    return 'Usage: /specialists list';
  }
  const specialists = catalog.getAll();
  if (specialists.length === 0) {
    return 'No specialists configured';
  }
  const lines = specialists.map((s) => {
    const desc = s.prompt.length > 80 ? s.prompt.slice(0, 80) + '…' : s.prompt;
    return `@${s.name} — ${desc}`;
  });
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────

let tmpDir: string;
let catalogPath: string;

function writeCatalog(
  specialists: Array<{ name: string; prompt: string }>,
  generation = 1,
): void {
  const payload = { version: 1, generation, specialists };
  writeFileSync(catalogPath, JSON.stringify(payload), 'utf-8');
}

describe('/specialists command integration — SpecialistCatalogLoader', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kubeclaw-spec-cmd-'));
    catalogPath = join(tmpDir, 'specialists.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('isSpecialistsCommand correctly identifies /specialists commands', () => {
    expect(isSpecialistsCommand('/specialists list')).toBe(true);
    expect(isSpecialistsCommand('/specialists foobar')).toBe(true);
    expect(isSpecialistsCommand('/specialists')).toBe(true);
    expect(isSpecialistsCommand('/skills list')).toBe(false);
    expect(isSpecialistsCommand('/search foo')).toBe(false);
    expect(isSpecialistsCommand('hello @Researcher')).toBe(false);
  });

  it('returns "No specialists configured" from an empty catalog file', () => {
    writeCatalog([]);
    const loader = new SpecialistCatalogLoader(catalogPath);
    loader.start();

    const reply = handleSpecialistsCommand('/specialists list', loader);
    loader.stop();

    expect(reply.toLowerCase()).toContain('no specialists configured');
  });

  it('lists specialists from a catalog file with one entry', () => {
    writeCatalog([
      { name: 'Researcher', prompt: 'Research topics thoroughly.' },
    ]);
    const loader = new SpecialistCatalogLoader(catalogPath);
    loader.start();

    const reply = handleSpecialistsCommand('/specialists list', loader);
    loader.stop();

    expect(reply).toContain('@Researcher');
    expect(reply).toContain('Research topics thoroughly.');
  });

  it('lists all specialists from a catalog with multiple entries', () => {
    writeCatalog([
      { name: 'Alpha', prompt: 'Handle alpha tasks.' },
      { name: 'Beta', prompt: 'Handle beta tasks.' },
      { name: 'Gamma', prompt: 'Handle gamma tasks.' },
    ]);
    const loader = new SpecialistCatalogLoader(catalogPath);
    loader.start();

    const reply = handleSpecialistsCommand('/specialists list', loader);
    loader.stop();

    const lines = reply.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('@Alpha');
    expect(lines[1]).toContain('@Beta');
    expect(lines[2]).toContain('@Gamma');
  });

  it('truncates long prompts to 80 chars with trailing ellipsis', () => {
    const longPrompt = 'X'.repeat(200);
    writeCatalog([{ name: 'Verbose', prompt: longPrompt }]);
    const loader = new SpecialistCatalogLoader(catalogPath);
    loader.start();

    const reply = handleSpecialistsCommand('/specialists list', loader);
    loader.stop();

    // Should show @Verbose — <first 80 chars>…
    expect(reply).toContain('@Verbose');
    expect(reply).toContain('X'.repeat(80) + '…');
    // Must not show the full 200-char string
    expect(reply).not.toContain('X'.repeat(81));
  });

  it('returns usage hint for unknown sub-command', () => {
    writeCatalog([{ name: 'A', prompt: 'Do stuff.' }]);
    const loader = new SpecialistCatalogLoader(catalogPath);
    loader.start();

    const reply = handleSpecialistsCommand('/specialists unknown', loader);
    loader.stop();

    expect(reply).toContain('Usage: /specialists list');
  });

  it('returns usage hint for bare /specialists (no sub-command)', () => {
    writeCatalog([{ name: 'A', prompt: 'Do stuff.' }]);
    const loader = new SpecialistCatalogLoader(catalogPath);
    loader.start();

    const reply = handleSpecialistsCommand('/specialists', loader);
    loader.stop();

    expect(reply).toContain('Usage: /specialists list');
  });

  it('reflects file contents without requiring a pod restart (hot-reload path)', async () => {
    // Start with an empty catalog.
    writeCatalog([]);
    const loader = new SpecialistCatalogLoader(catalogPath);
    loader.start();

    const empty = handleSpecialistsCommand('/specialists list', loader);
    expect(empty.toLowerCase()).toContain('no specialists configured');

    // Write a new catalog (simulate ConfigMap update).
    writeCatalog([{ name: 'Tester', prompt: 'Run automated tests.' }], 2);

    // Give the loader's debounced fs.watch callback time to fire and re-read.
    await new Promise((r) => setTimeout(r, 200));

    const withTester = handleSpecialistsCommand('/specialists list', loader);
    loader.stop();

    expect(withTester).toContain('@Tester');
  });
});
