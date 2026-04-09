import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { Channel } from './types.js';

export interface SendFileMarker {
  rawMatch: string; // the full marker text to strip
  filePath: string; // relative path, e.g. "attachments/generated/foo.png"
  caption?: string;
}

/**
 * Parse [SendFile: path/to/file] or [SendFile: path/to/file caption="..."] markers
 * from agent response text. Rejects any marker whose filePath contains "..".
 */
export function parseSendFileMarkers(text: string): SendFileMarker[] {
  // Matches: [SendFile: some/path.ext] or [SendFile: some/path.ext caption="..."]
  const re = /\[SendFile:\s+([^\]\s"]+)(?:\s+caption="([^"]*)")?\]/g;
  const results: SendFileMarker[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const rawMatch = m[0];
    const filePath = m[1];
    const caption = m[2]; // undefined if not present

    // Reject path traversal
    if (filePath.includes('..')) {
      logger.warn({ filePath }, 'SendFile marker rejected: path contains ".."');
      continue;
    }

    results.push({ rawMatch, filePath, caption });
  }
  return results;
}

/**
 * Detect MIME type from file extension.
 */
function mediaTypeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
      return 'audio/ogg';
    case '.wav':
      return 'audio/wav';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Handle [SendFile: ...] markers in agent response text.
 *
 * For each marker:
 * - Resolves the absolute path under the group folder
 * - Rejects paths with ".." or that escape the group folder
 * - Detects mediaType from file extension
 * - If channel.sendMedia exists: reads file and calls sendMedia
 * - If not: replaces marker with a fallback [File: filename] text
 *
 * Returns the cleaned response text (markers stripped or replaced).
 */
export async function handleSendFileMarkers(
  text: string,
  channel: Channel,
  jid: string,
  groupFolder: string,
  groupsDir: string,
): Promise<string> {
  const markers = parseSendFileMarkers(text);
  if (markers.length === 0) return text;

  const groupFolderAbs = path.resolve(groupsDir, groupFolder);
  let result = text;

  for (const marker of markers) {
    // Resolve absolute path
    const absPath = path.resolve(groupFolderAbs, marker.filePath);

    // Security: ensure it stays within the group folder
    if (
      !absPath.startsWith(groupFolderAbs + path.sep) &&
      absPath !== groupFolderAbs
    ) {
      logger.warn(
        { filePath: marker.filePath, absPath, groupFolderAbs },
        'SendFile marker rejected: path escapes group folder',
      );
      result = result.replace(marker.rawMatch, '');
      continue;
    }

    const mediaType = mediaTypeFromExt(marker.filePath);
    const filename = path.basename(marker.filePath);

    if (channel.sendMedia) {
      try {
        const buffer = fs.readFileSync(absPath);
        await channel.sendMedia(jid, buffer, mediaType, marker.caption);
        logger.info(
          { jid, filePath: marker.filePath, mediaType },
          'Sent media via channel',
        );
      } catch (err) {
        logger.warn(
          { jid, filePath: marker.filePath, err },
          'Failed to send media',
        );
      }
      // Strip the marker from the text
      result = result.replace(marker.rawMatch, '');
    } else {
      // Fallback: replace with a plain-text reference
      const fallback = `[File: ${filename}]`;
      result = result.replace(marker.rawMatch, fallback);
    }
  }

  return result.trim();
}
