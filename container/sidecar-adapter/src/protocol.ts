/**
 * NanoClaw protocol handling for sidecar adapter
 * Wraps output in markers for stdout protocol compatibility
 */

import { TaskOutput } from './types.js';

// Must match markers in container/agent-runner/src/index.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export class ProtocolHandler {
  /**
   * Write output wrapped in NanoClaw markers to stdout
   */
  writeOutput(output: TaskOutput): void {
    console.log(OUTPUT_START_MARKER);
    console.log(JSON.stringify(output));
    console.log(OUTPUT_END_MARKER);
  }

  /**
   * Write final completion marker
   */
  writeCompletion(newSessionId?: string): void {
    console.log(OUTPUT_START_MARKER);
    console.log(
      JSON.stringify({
        status: 'success',
        result: null,
        newSessionId,
      }),
    );
    console.log(OUTPUT_END_MARKER);
  }

  /**
   * Write error output
   */
  writeError(error: string): void {
    console.log(OUTPUT_START_MARKER);
    console.log(
      JSON.stringify({
        status: 'error',
        result: null,
        error,
      }),
    );
    console.log(OUTPUT_END_MARKER);
  }

  /**
   * Log to stderr (won't interfere with stdout protocol)
   */
  log(message: string): void {
    console.error(`[sidecar-adapter] ${message}`);
  }
}
