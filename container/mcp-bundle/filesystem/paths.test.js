import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSafePath } from './paths.js';

let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'paths-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveSafePath', () => {
  it('accepts a simple relative path', () => {
    writeFileSync(path.join(root, 'foo.md'), 'x');
    const resolved = resolveSafePath(root, 'foo.md');
    expect(resolved).toBe(path.join(root, 'foo.md'));
  });

  it('accepts a nested relative path', () => {
    mkdirSync(path.join(root, 'a/b'), { recursive: true });
    writeFileSync(path.join(root, 'a/b/c.md'), 'x');
    const resolved = resolveSafePath(root, 'a/b/c.md');
    expect(resolved).toBe(path.join(root, 'a/b/c.md'));
  });

  it('rejects absolute paths', () => {
    expect(() => resolveSafePath(root, '/etc/passwd')).toThrow(
      /absolute path/i,
    );
  });

  it('rejects parent-directory traversal', () => {
    expect(() => resolveSafePath(root, '../foo')).toThrow(/traversal/i);
    expect(() => resolveSafePath(root, 'a/../../foo')).toThrow(/traversal/i);
  });

  it('rejects symlinks that escape root', () => {
    symlinkSync('/etc/passwd', path.join(root, 'evil'));
    expect(() => resolveSafePath(root, 'evil')).toThrow(/outside root/i);
  });

  it('accepts symlinks that point within root', () => {
    writeFileSync(path.join(root, 'target.md'), 'x');
    symlinkSync(path.join(root, 'target.md'), path.join(root, 'link'));
    const resolved = resolveSafePath(root, 'link');
    expect(resolved).toBe(path.join(root, 'target.md'));
  });

  it('accepts non-existent paths inside root (for write/create)', () => {
    const resolved = resolveSafePath(root, 'new-file.md');
    expect(resolved).toBe(path.join(root, 'new-file.md'));
  });

  it('rejects an empty path', () => {
    expect(() => resolveSafePath(root, '')).toThrow();
  });
});
