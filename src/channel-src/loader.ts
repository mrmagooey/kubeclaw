// src/channel-src/loader.ts
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelSourceFile } from '../k8s/write-bootstrap-pvc-files.js';

const DEFAULT_DIR = '/etc/kubeclaw/channel-src';
const SEP = '__';

export function decodeKey(fileName: string): { channelType: string; relPath: string } | null {
  const idx = fileName.indexOf(SEP);
  if (idx <= 0) return null;
  const channelType = fileName.slice(0, idx);
  const relPath = fileName.slice(idx + SEP.length).split(SEP).join('/');
  if (!relPath) return null;
  return { channelType, relPath };
}

export function loadChannelSource(
  channelType: string,
  baselineDir: string = DEFAULT_DIR,
): ChannelSourceFile[] {
  if (!existsSync(baselineDir)) return [];
  const out: ChannelSourceFile[] = [];
  for (const name of readdirSync(baselineDir)) {
    const decoded = decodeKey(name);
    if (!decoded || decoded.channelType !== channelType) continue;
    out.push({ path: decoded.relPath, content: readFileSync(join(baselineDir, name), 'utf8') });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
