import path from 'node:path';
import fs from 'node:fs';

/**
 * Resolve a user-supplied path against a root directory, with safety checks:
 *
 *   1. Reject absolute paths.
 *   2. Reject paths whose normalised form starts with `..` (traversal).
 *   3. If the target exists, fs.realpath it (resolves symlinks) and verify
 *      the result is still inside `root` (catches symlink escape).
 *   4. If the target doesn't exist, accept (caller is likely about to write
 *      or create it). The joined path must still be inside root.
 *
 * Returns the absolute, realpath'd path inside `root`. Throws on violation.
 */
export function resolveSafePath(root, rawPath) {
  if (rawPath === undefined || rawPath === null || rawPath === '') {
    throw new Error('path is required');
  }
  if (path.isAbsolute(rawPath)) {
    throw new Error(`absolute path not allowed: ${rawPath}`);
  }

  const normalised = path.posix.normalize(rawPath);
  if (normalised.startsWith('..') || normalised === '..') {
    throw new Error(`path traversal not allowed: ${rawPath}`);
  }

  const joined = path.resolve(root, normalised);
  if (!isUnder(joined, root)) {
    throw new Error(`path traversal not allowed: ${rawPath}`);
  }

  // If the target exists, realpath it so we catch symlink escape.
  if (fs.existsSync(joined)) {
    const real = fs.realpathSync(joined);
    if (!isUnder(real, fs.realpathSync(root))) {
      throw new Error(`symlink target outside root: ${rawPath}`);
    }
    return real;
  }
  return joined;
}

function isUnder(target, root) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
