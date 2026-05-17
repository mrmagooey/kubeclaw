import { createHash } from 'crypto';

export function groupHash(groupFolder: string): string {
  const trimmed = groupFolder.trim();
  if (trimmed.length === 0) {
    throw new Error('groupHash: groupFolder must be non-empty');
  }
  return createHash('sha1').update(trimmed, 'utf8').digest('hex').slice(0, 10);
}
