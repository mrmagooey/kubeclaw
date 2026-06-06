/**
 * KubeClaw channel-loader — steady-state entrypoint for the kubeclaw-agent image.
 *
 * Bootstrap mode (KUBECLAW_BOOTSTRAP_SKILL set) is handled inside the agent-runner
 * itself (`dist/index.js`) via runBootstrapMode(). The entrypoint script dispatches
 * bootstrap-mode invocations directly to dist/index.js without going through this
 * file.
 *
 * This loader is invoked ONLY when /runtime/channel-entry.js exists (post-bootstrap
 * steady-state pod). It imports that file as an ES module and hands over control.
 * The PVC is mounted read-only at /runtime, so the channel cannot modify its own
 * runtime — customisation happened during bootstrap and was committed.
 */

import { existsSync } from 'node:fs';

function log(msg) {
  process.stderr.write(`[channel-loader] ${msg}\n`);
}

async function runSteadyStateMode() {
  log('Steady-state mode: loading /runtime/channel-entry.js');
  const entryPath = '/runtime/channel-entry.js';
  if (!existsSync(entryPath)) {
    log(`ERROR: ${entryPath} not found. Has the channel been bootstrapped?`);
    process.exit(1);
  }
  await import(entryPath);
}

runSteadyStateMode().catch((err) => {
  log(`Fatal error in steady-state mode: ${err.stack || err.message}`);
  process.exit(1);
});
