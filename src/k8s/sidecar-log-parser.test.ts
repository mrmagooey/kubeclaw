/**
 * Tests for the sidecar log parser — pure marker extraction logic shared by
 * all three sidecar runner variants.
 *
 * The parser processes a string buffer accumulated from repeated
 * readNamespacedPodLog calls and extracts JSON payloads delimited by:
 *
 *   ---NANOCLAW_OUTPUT_START---
 *   <json>
 *   ---NANOCLAW_OUTPUT_END---
 */

import { describe, it, expect } from 'vitest';
import {
  parseSidecarLogBuffer,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
} from './sidecar-log-parser.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function wrap(json: string): string {
  return `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}`;
}

// ── happy path ────────────────────────────────────────────────────────────────

describe('parseSidecarLogBuffer — happy path', () => {
  it('extracts a single complete marker pair', () => {
    const json = '{"status":"success","result":"hello"}';
    const { extracted, remaining } = parseSidecarLogBuffer(wrap(json));

    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toBe(json);
    expect(remaining).toBe('');
  });

  it('returns empty extracted array for an empty buffer', () => {
    const { extracted, remaining } = parseSidecarLogBuffer('');
    expect(extracted).toHaveLength(0);
    expect(remaining).toBe('');
  });

  it('returns empty extracted array for buffer with no markers', () => {
    const { extracted, remaining } = parseSidecarLogBuffer(
      'line1\nline2\nline3\n',
    );
    expect(extracted).toHaveLength(0);
    expect(remaining).toBe('line1\nline2\nline3\n');
  });

  it('trims whitespace around the JSON payload', () => {
    const buffer =
      `${OUTPUT_START_MARKER}\n` +
      `   {"status":"error","result":null}   \n` +
      `${OUTPUT_END_MARKER}`;

    const { extracted } = parseSidecarLogBuffer(buffer);
    expect(extracted[0]).toBe('{"status":"error","result":null}');
  });
});

// ── log lines before and after markers ───────────────────────────────────────

describe('parseSidecarLogBuffer — markers embedded mid-log', () => {
  it('ignores log lines before the START marker', () => {
    const buffer =
      'INFO Starting adapter\n' +
      'DEBUG Processing request\n' +
      wrap('{"status":"success","result":"done"}') +
      '\n';

    const { extracted, remaining } = parseSidecarLogBuffer(buffer);

    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toBe('{"status":"success","result":"done"}');
    // Everything before the START is consumed as part of the slice up to startIdx
    // BUT because parseSidecarLogBuffer slices from endIdx+END_MARKER.length,
    // only text after the END marker survives in remaining.
    expect(remaining).toBe('\n');
  });

  it('preserves log lines that appear after the END marker in remaining', () => {
    const buffer =
      wrap('{"status":"success","result":"x"}') + '\nsome trailing log line\n';

    const { remaining } = parseSidecarLogBuffer(buffer);
    expect(remaining).toBe('\nsome trailing log line\n');
  });

  it('handles log lines both before and after the marker pair', () => {
    const json = '{"status":"success","result":"42"}';
    const buffer =
      'INIT adapter v1.0\n' +
      `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n` +
      'DONE processing\n';

    const { extracted, remaining } = parseSidecarLogBuffer(buffer);

    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toBe(json);
    expect(remaining).toBe('\nDONE processing\n');
  });
});

// ── multi-line content ────────────────────────────────────────────────────────

describe('parseSidecarLogBuffer — multi-line content between markers', () => {
  it('extracts JSON spanning multiple lines', () => {
    const json = `{
  "status": "success",
  "result": "line one\\nline two\\nline three"
}`;
    const buffer = `${OUTPUT_START_MARKER}\n` + json + `\n${OUTPUT_END_MARKER}`;

    const { extracted } = parseSidecarLogBuffer(buffer);
    expect(extracted).toHaveLength(1);
    // trim() is applied so leading/trailing newlines around json are stripped
    expect(extracted[0]).toBe(json);
  });

  it('handles content with blank lines between markers', () => {
    const buffer =
      `${OUTPUT_START_MARKER}\n\n` +
      `{"status":"success","result":null}\n\n` +
      `${OUTPUT_END_MARKER}`;

    const { extracted } = parseSidecarLogBuffer(buffer);
    expect(extracted[0]).toBe('{"status":"success","result":null}');
  });
});

// ── split across fetches ──────────────────────────────────────────────────────

describe('parseSidecarLogBuffer — split across multiple fetches', () => {
  it('returns no extraction when only START marker is present', () => {
    const partial = `${OUTPUT_START_MARKER}\n{"status":"success","result":"x"}`;

    const { extracted, remaining } = parseSidecarLogBuffer(partial);

    expect(extracted).toHaveLength(0);
    // The buffer is preserved intact so the caller can append more data
    expect(remaining).toBe(partial);
  });

  it('completes extraction on second fetch when END marker arrives', () => {
    // First fetch: START and partial JSON
    const fetch1 = `${OUTPUT_START_MARKER}\n{"status":"success","result":"x"}`;
    const { extracted: e1, remaining: r1 } = parseSidecarLogBuffer(fetch1);

    expect(e1).toHaveLength(0);

    // Second fetch: END marker appended
    const fetch2 = r1 + `\n${OUTPUT_END_MARKER}`;
    const { extracted: e2, remaining: r2 } = parseSidecarLogBuffer(fetch2);

    expect(e2).toHaveLength(1);
    expect(e2[0]).toBe('{"status":"success","result":"x"}');
    expect(r2).toBe('');
  });

  it('handles START in one fetch and content+END in the next', () => {
    const startOnly = `some log\n${OUTPUT_START_MARKER}`;
    const { remaining: r1 } = parseSidecarLogBuffer(startOnly);

    const combined =
      r1 + `\n{"status":"error","result":null}\n${OUTPUT_END_MARKER}\nmore log`;
    const { extracted, remaining } = parseSidecarLogBuffer(combined);

    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toBe('{"status":"error","result":null}');
    expect(remaining).toBe('\nmore log');
  });

  it('handles the case where the buffer grows across three fetches', () => {
    const json = '{"status":"success","result":"chunked"}';

    // Fetch 1: just the START marker
    const { remaining: r1 } = parseSidecarLogBuffer(`${OUTPUT_START_MARKER}`);

    // Fetch 2: START (carried over) + partial JSON
    const { remaining: r2 } = parseSidecarLogBuffer(
      r1 + `\n${json.slice(0, 20)}`,
    );

    // Fetch 3: rest of JSON + END
    const { extracted, remaining: r3 } = parseSidecarLogBuffer(
      r2 + json.slice(20) + `\n${OUTPUT_END_MARKER}`,
    );

    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toBe(json);
    expect(r3).toBe('');
  });
});

// ── multiple marker pairs ─────────────────────────────────────────────────────

describe('parseSidecarLogBuffer — multiple marker pairs', () => {
  it('extracts two complete pairs in a single buffer', () => {
    const json1 = '{"status":"success","result":"first"}';
    const json2 = '{"status":"success","result":"second"}';
    const buffer = wrap(json1) + '\n' + wrap(json2);

    const { extracted, remaining } = parseSidecarLogBuffer(buffer);

    expect(extracted).toHaveLength(2);
    expect(extracted[0]).toBe(json1);
    expect(extracted[1]).toBe(json2);
    expect(remaining).toBe('');
  });

  it('extracts three pairs with log lines between them', () => {
    const json1 = '{"status":"success","result":"a"}';
    const json2 = '{"status":"success","result":"b"}';
    const json3 = '{"status":"success","result":null}';
    const buffer =
      'log before\n' +
      wrap(json1) +
      '\nlog between\n' +
      wrap(json2) +
      '\nmore log\n' +
      wrap(json3) +
      '\nlog after\n';

    const { extracted } = parseSidecarLogBuffer(buffer);

    expect(extracted).toHaveLength(3);
    expect(extracted[0]).toBe(json1);
    expect(extracted[1]).toBe(json2);
    expect(extracted[2]).toBe(json3);
  });

  it('stops after processing complete pairs and leaves incomplete pair in remaining', () => {
    const complete = wrap('{"status":"success","result":"done"}');
    const incomplete = `${OUTPUT_START_MARKER}\n{"status":"success","result":"pending"}`;
    const buffer = complete + '\n' + incomplete;

    const { extracted, remaining } = parseSidecarLogBuffer(buffer);

    expect(extracted).toHaveLength(1);
    // The incomplete pair is preserved
    expect(remaining).toContain(OUTPUT_START_MARKER);
    expect(remaining).not.toContain(OUTPUT_END_MARKER);
  });
});

// ── malformed markers ─────────────────────────────────────────────────────────

describe('parseSidecarLogBuffer — malformed markers', () => {
  it('returns empty extraction for END-only marker (no preceding START)', () => {
    const buffer = `{"status":"success","result":"x"}\n${OUTPUT_END_MARKER}`;

    const { extracted, remaining } = parseSidecarLogBuffer(buffer);

    expect(extracted).toHaveLength(0);
    // Content before END marker remains in the buffer as is (no START found)
    expect(remaining).toBe(buffer);
  });

  it('leaves orphaned START in remaining when no END is present', () => {
    const buffer = `junk\n${OUTPUT_START_MARKER}\n{"status":"success"}`;

    const { extracted, remaining } = parseSidecarLogBuffer(buffer);

    expect(extracted).toHaveLength(0);
    expect(remaining).toBe(buffer);
  });

  it('handles an END marker that appears before a START — treats as no extraction', () => {
    // END first, then a complete pair
    const json = '{"status":"success","result":"ok"}';
    const buffer = `${OUTPUT_END_MARKER}\n` + wrap(json);

    const { extracted } = parseSidecarLogBuffer(buffer);

    // The complete pair after the stray END is still extracted
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toBe(json);
  });

  it('handles adjacent START markers — inner content extracted', () => {
    // Two START markers before one END: the slice is from the *first* START
    // to the first END, which includes the second START as content.
    const buffer =
      `${OUTPUT_START_MARKER}` +
      `${OUTPUT_START_MARKER}\n{"status":"success","result":"nested"}\n` +
      `${OUTPUT_END_MARKER}`;

    const { extracted } = parseSidecarLogBuffer(buffer);

    // The parser takes from startIdx (first START) to first END
    expect(extracted).toHaveLength(1);
    // The second START marker ends up as part of the extracted JSON string
    expect(extracted[0]).toContain(OUTPUT_START_MARKER);
  });
});

// ── tailLines truncation risk ─────────────────────────────────────────────────

describe('parseSidecarLogBuffer — tailLines truncation risk', () => {
  /**
   * When the K8s API is called with tailLines: 100, any markers that appear
   * only in log line 101 or later are silently dropped — the poll returns only
   * the last 100 lines so the START/END pair is never seen.
   *
   * This test documents the risk: the parser itself behaves correctly (no
   * extraction, no error), but the caller is responsible for ensuring the log
   * window is large enough or using sinceSeconds to avoid truncation.
   */
  it('returns no extraction when markers are absent from the fetched tail (truncation scenario)', () => {
    // Simulate 101 log lines where the markers were only in lines 1–5
    // but tailLines: 100 fetched lines 2–101 (markers excluded)
    const truncatedTail = Array.from(
      { length: 100 },
      (_, i) => `log line ${i + 2}`,
    ).join('\n');

    const { extracted } = parseSidecarLogBuffer(truncatedTail);

    // No markers in the tail — nothing extracted, no error thrown
    expect(extracted).toHaveLength(0);
  });

  it('correctly extracts markers that appear within the 100-line tail window', () => {
    // 50 preamble lines, then the marker pair — all within the 100-line window
    const preamble =
      Array.from({ length: 50 }, (_, i) => `log ${i}`).join('\n') + '\n';
    const json = '{"status":"success","result":"within window"}';
    const buffer = preamble + wrap(json);

    const { extracted } = parseSidecarLogBuffer(buffer);

    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toBe(json);
  });

  it('documents that repeated buffer accumulation can cause duplicate marker processing', () => {
    /**
     * The runners do `parseBuffer += logs` on every poll, and tailLines: 100
     * always returns the same last 100 lines.  Markers that haven't been
     * consumed (e.g. because the END hadn't arrived yet) can appear again in
     * the next poll's tail.
     *
     * Once a pair IS consumed, `remaining` no longer contains it, so the
     * completed pair won't be re-processed.  But if the same pair appears in
     * two consecutive tails before being consumed, it could be processed twice.
     *
     * This test verifies the parser is idempotent: if the same complete pair
     * is appended twice (simulating two consecutive polls with identical tails),
     * both copies are extracted — the caller must handle deduplication if needed.
     */
    const json = '{"status":"success","result":"r"}';
    const singlePair = wrap(json);

    // Simulate: first poll returns the pair, second poll also returns the same
    // tail (tailLines: 100 makes this possible), and the caller naively does
    // parseBuffer += logs without deduplication.
    const buffer = singlePair + singlePair;

    const { extracted } = parseSidecarLogBuffer(buffer);

    // Both copies are extracted — the runner is responsible for avoiding this
    // by not accumulating already-processed lines (e.g. use sinceSeconds).
    expect(extracted).toHaveLength(2);
    expect(extracted[0]).toBe(json);
    expect(extracted[1]).toBe(json);
  });
});

// ── no output case ────────────────────────────────────────────────────────────

describe('parseSidecarLogBuffer — no output case', () => {
  it('returns empty array and original buffer when job produces no markers', () => {
    const buffer =
      'Starting adapter...\n' +
      'Waiting for input file...\n' +
      'Timeout reached, exiting.\n';

    const { extracted, remaining } = parseSidecarLogBuffer(buffer);

    expect(extracted).toHaveLength(0);
    expect(remaining).toBe(buffer);
  });

  it('handles a completely empty buffer without throwing', () => {
    expect(() => parseSidecarLogBuffer('')).not.toThrow();
    const { extracted, remaining } = parseSidecarLogBuffer('');
    expect(extracted).toHaveLength(0);
    expect(remaining).toBe('');
  });

  it('handles a buffer with only whitespace without throwing', () => {
    const { extracted } = parseSidecarLogBuffer('   \n\t\n   ');
    expect(extracted).toHaveLength(0);
  });
});
