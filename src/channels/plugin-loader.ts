import fs from 'fs';
import { pathToFileURL } from 'url';

import { logger } from '../logger.js';
import { registerChannel } from './registry.js';
import type { ChannelPluginContext } from './registry.js';

const pluginContext: ChannelPluginContext = { registerChannel };

/**
 * Scans `dir` for `*.js` files and dynamically imports each one as a channel
 * plugin.
 *
 * Called at startup (from both `src/index.ts` and `src/channel-runner.ts`)
 * with `/workspace/plugins` as the directory. If the directory does not exist
 * the function returns immediately without error, so installs without plugins
 * are unaffected.
 *
 * Each file must export a default function matching the
 * `(ctx: ChannelPluginContext) => void` signature. Files that do not export a
 * default function are silently skipped; files that throw during import are
 * logged as errors and the remaining plugins continue to load.
 */
export async function loadChannelPlugins(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(`${dir}/${file}`).href);
      if (typeof mod.default === 'function') {
        mod.default(pluginContext);
        logger.info({ plugin: file }, 'Channel plugin loaded');
      }
    } catch (err) {
      logger.error({ plugin: file, err }, 'Failed to load channel plugin');
    }
  }
}
