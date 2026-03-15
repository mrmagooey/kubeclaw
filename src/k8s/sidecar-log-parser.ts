/**
 * Sidecar Log Parser — pure marker extraction for NanoClaw sidecar runners.
 *
 * All three sidecar runner variants (sidecar-job-runner, file-sidecar-runner,
 * http-sidecar-runner) share identical marker-parsing logic. This module
 * extracts that logic into a single testable unit so it only lives in one
 * place.
 *
 * Protocol
 * --------
 * The sidecar adapter container writes structured output to stdout wrapped in
 * sentinel markers:
 *
 *   ---NANOCLAW_OUTPUT_START---
 *   {"status":"success","result":"..."}
 *   ---NANOCLAW_OUTPUT_END---
 *
 * The runner polls for logs (with tailLines: 100) and accumulates them in a
 * string buffer.  Each call to `parseSidecarLogBuffer` consumes complete
 * marker pairs from the front of the buffer and returns:
 *   - an array of extracted JSON strings (in order of appearance)
 *   - the unconsumed remainder of the buffer
 *
 * tailLines truncation risk
 * -------------------------
 * `readNamespacedPodLog` is called with `tailLines: 100`.  If the markers
 * appear only in log line 101 or later they will never be captured.  The
 * runner should use `sinceSeconds` or an increasing offset to avoid this, but
 * that is a caller-level concern; this parser has no opinion on it.  The risk
 * is documented here and covered by a test that verifies the parser correctly
 * handles a buffer that was already truncated (markers never appear).
 */

export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ParseResult {
  /** Extracted JSON strings between every complete START/END pair found */
  extracted: string[];
  /** The unconsumed tail of the buffer after all complete pairs were removed */
  remaining: string;
}

/**
 * Parse a log buffer and extract all complete marker-delimited JSON payloads.
 *
 * - Pairs are consumed left-to-right.
 * - An orphaned END before the first START is silently ignored (the character
 *   before the marker is kept so subsequent START markers are still found).
 * - An orphaned START with no matching END is left in `remaining` so it can
 *   be completed in the next fetch.
 * - Multiple pairs in a single buffer are all extracted in order.
 */
export function parseSidecarLogBuffer(buffer: string): ParseResult {
  const extracted: string[] = [];
  let remaining = buffer;

  let startIdx: number;
  while ((startIdx = remaining.indexOf(OUTPUT_START_MARKER)) !== -1) {
    const endIdx = remaining.indexOf(OUTPUT_END_MARKER, startIdx);
    if (endIdx === -1) {
      // Incomplete pair — wait for more data
      break;
    }

    const jsonStr = remaining
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();

    // Advance buffer past the END marker
    remaining = remaining.slice(endIdx + OUTPUT_END_MARKER.length);

    extracted.push(jsonStr);
  }

  return { extracted, remaining };
}
