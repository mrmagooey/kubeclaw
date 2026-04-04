/**
 * Standalone K8s Job entrypoint for attachment preprocessing.
 * Reads KUBECLAW_ATTACHMENTS env var (JSON RawAttachment[]), processes each file,
 * and writes a .done sidecar containing the relative output path on success.
 *
 * Added by the add-image-vision skill. The add-pdf-reader skill extends this
 * file with a PDF else-if branch.
 */
import fs from 'fs';
import path from 'path';

import sharp from 'sharp';

interface RawAttachment {
  rawPath: string;
  mediaType: string;
  caption?: string;
}

const GROUP_DIR = '/workspace/group';
const attachments: RawAttachment[] = JSON.parse(
  process.env.KUBECLAW_ATTACHMENTS ?? '[]',
);

async function main(): Promise<void> {
  if (attachments.length === 0) {
    console.log('No attachments to process.');
    process.exit(0);
  }

  let anyFailed = false;

  for (const att of attachments) {
    const rawAbsPath = path.join(GROUP_DIR, att.rawPath);

    if (!fs.existsSync(rawAbsPath)) {
      console.error(`Missing raw file: ${att.rawPath}`);
      anyFailed = true;
      continue;
    }

    try {
      if (att.mediaType.startsWith('image/')) {
        const outName = path.basename(att.rawPath)
          .replace(/^raw-/, '')
          .replace(/\.[^.]+$/, '.jpg');
        const outDir = path.join(GROUP_DIR, 'attachments');
        fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, outName);

        const buffer = fs.readFileSync(rawAbsPath);
        const resized = await sharp(buffer)
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        fs.writeFileSync(outPath, resized);

        // Write .done sidecar — orchestrator reads this to resolve the output path
        fs.writeFileSync(rawAbsPath + '.done', `attachments/${outName}`);
        console.log(`Processed image: ${att.rawPath} → attachments/${outName}`);
      }
      // PDF handling: add-pdf-reader skill adds an else-if block here
    } catch (err) {
      console.error(`Failed to process ${att.rawPath}:`, err);
      anyFailed = true;
    }
  }

  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
