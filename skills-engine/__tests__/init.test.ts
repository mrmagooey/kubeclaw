import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { initNanoclawDir } from '../init.js';
import { createTempDir, cleanup } from './test-helpers.js';

describe('initNanoclawDir', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  it('creates .kubeclaw/backup and .kubeclaw/base directories', () => {
    initNanoclawDir();
    expect(fs.existsSync(path.join(tmpDir, '.kubeclaw', 'backup'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.kubeclaw', 'base'))).toBe(true);
  });

  it('writes initial state file with correct structure', () => {
    initNanoclawDir();
    const stateFile = path.join(tmpDir, '.kubeclaw', 'state.yaml');
    expect(fs.existsSync(stateFile)).toBe(true);
    const content = fs.readFileSync(stateFile, 'utf-8');
    expect(content).toContain('skills_system_version');
    expect(content).toContain('applied_skills');
  });

  it('reads version from package.json into state', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ version: '3.1.4', name: 'test' }),
    );
    initNanoclawDir();
    const stateFile = path.join(tmpDir, '.kubeclaw', 'state.yaml');
    const content = fs.readFileSync(stateFile, 'utf-8');
    expect(content).toContain('3.1.4');
  });

  it('falls back to 0.0.0 when package.json is missing', () => {
    initNanoclawDir();
    const stateFile = path.join(tmpDir, '.kubeclaw', 'state.yaml');
    const content = fs.readFileSync(stateFile, 'utf-8');
    expect(content).toContain('0.0.0');
  });

  it('snapshots package.json into .kubeclaw/base when present', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ version: '2.0.0', name: 'test' }),
    );
    initNanoclawDir();
    expect(
      fs.existsSync(path.join(tmpDir, '.kubeclaw', 'base', 'package.json')),
    ).toBe(true);
  });

  it('snapshots src/ directory contents into .kubeclaw/base', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {}');
    initNanoclawDir();
    expect(
      fs.existsSync(path.join(tmpDir, '.kubeclaw', 'base', 'src', 'index.ts')),
    ).toBe(true);
  });

  it('cleans existing base dir before re-initializing', () => {
    fs.mkdirSync(path.join(tmpDir, '.kubeclaw', 'base'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.kubeclaw', 'base', 'stale.txt'),
      'old content',
    );
    initNanoclawDir();
    expect(
      fs.existsSync(path.join(tmpDir, '.kubeclaw', 'base', 'stale.txt')),
    ).toBe(false);
  });

  it('does not throw when no BASE_INCLUDES paths exist', () => {
    expect(() => initNanoclawDir()).not.toThrow();
  });

  it('excludes node_modules and .git from src/ snapshot', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'node_modules'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'node_modules', 'pkg.js'),
      'module',
    );
    fs.writeFileSync(path.join(tmpDir, 'src', 'real.ts'), 'code');
    initNanoclawDir();
    expect(
      fs.existsSync(
        path.join(tmpDir, '.kubeclaw', 'base', 'src', 'node_modules'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(tmpDir, '.kubeclaw', 'base', 'src', 'real.ts')),
    ).toBe(true);
  });
});
