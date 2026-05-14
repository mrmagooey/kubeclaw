import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfigOrThrow } from './index.js';

describe('loadConfigOrThrow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a well-formed broker config YAML', () => {
    const file = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(
      file,
      [
        'mappings:',
        '  - id: anthropic',
        '    destinations:',
        '      - api.anthropic.com',
        '    identities:',
        '      - sa/kubeclaw-tool-job',
        '    credentialRef:',
        '      kind: Secret',
        '      name: kubeclaw-secrets',
        '      key: ANTHROPIC_API_KEY',
        '    headerScheme: bearer',
        '',
      ].join('\n'),
    );
    const cfg = loadConfigOrThrow(file);
    expect(cfg.mappings).toHaveLength(1);
    expect(cfg.mappings[0].id).toBe('anthropic');
    expect(cfg.mappings[0].destinations).toContain('api.anthropic.com');
  });

  it('throws with a "not readable" message for a missing file', () => {
    const missing = path.join(tmpDir, 'does-not-exist.yaml');
    expect(() => loadConfigOrThrow(missing)).toThrow(/not readable/i);
    expect(() => loadConfigOrThrow(missing)).toThrow(missing);
  });

  it('throws with an "invalid" message for non-YAML garbage', () => {
    const file = path.join(tmpDir, 'bad.yaml');
    fs.writeFileSync(file, 'mappings: : : not valid yaml\n');
    expect(() => loadConfigOrThrow(file)).toThrow(/invalid/i);
  });

  it('throws with an "invalid" message when schema validation fails', () => {
    const file = path.join(tmpDir, 'schema-bad.yaml');
    fs.writeFileSync(file, 'mappings: "this should be an array"\n');
    expect(() => loadConfigOrThrow(file)).toThrow(/invalid/i);
  });

  it('preserves the underlying error as the cause', () => {
    const missing = path.join(tmpDir, 'absent.yaml');
    try {
      loadConfigOrThrow(missing);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    }
  });
});
