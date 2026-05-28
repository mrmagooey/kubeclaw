/**
 * Unit tests for tool-server.ts
 *
 * Focused on the web_search HTML fallback truncation behaviour.
 * We cannot import tool-server.ts directly (it auto-executes main()),
 * so we re-implement and test the specific logic under test in isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Reproduce the env-var-driven fallback truncation logic from tool-server.ts
 * so we can test it without importing the module (which would call main()).
 */
function getMaxToolOutputBytesSearch(): number {
  return parseInt(
    process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES_SEARCH || '5000',
    10,
  );
}

function getMaxToolOutputBytes(): number {
  return parseInt(
    process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES || '50000',
    10,
  );
}

/**
 * Mirrors the fallback slice in toolWebSearch:
 *   return results || html.slice(0, MAX_TOOL_OUTPUT_BYTES_SEARCH);
 */
function applySearchFallback(html: string): string {
  // simulate: no regex matches → empty results → fallback to html slice
  const results = '';
  return results || html.slice(0, getMaxToolOutputBytesSearch());
}

/**
 * Mirrors the slice in toolWebFetch:
 *   return text.slice(0, MAX_TOOL_OUTPUT_BYTES);
 */
function applyFetchTruncation(text: string): string {
  return text.slice(0, getMaxToolOutputBytes());
}

describe('web_search fallback truncation', () => {
  let savedSearch: string | undefined;
  let savedFetch: string | undefined;

  beforeEach(() => {
    savedSearch = process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES_SEARCH;
    savedFetch = process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES;
    delete process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES_SEARCH;
    delete process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES;
  });

  afterEach(() => {
    if (savedSearch === undefined) {
      delete process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES_SEARCH;
    } else {
      process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES_SEARCH = savedSearch;
    }
    if (savedFetch === undefined) {
      delete process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES;
    } else {
      process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES = savedFetch;
    }
  });

  it('truncates search fallback to ≤5000 bytes by default', () => {
    const bigHtml = 'x'.repeat(100_000);
    const result = applySearchFallback(bigHtml);
    expect(result.length).toBeLessThanOrEqual(5000);
    expect(result.length).toBe(5000);
  });

  it('search fallback default (5000) is much smaller than fetch default (50000)', () => {
    expect(getMaxToolOutputBytesSearch()).toBe(5000);
    expect(getMaxToolOutputBytes()).toBe(50_000);
    expect(getMaxToolOutputBytesSearch()).toBeLessThan(getMaxToolOutputBytes());
  });

  it('search fallback respects KUBECLAW_MAX_TOOL_OUTPUT_BYTES_SEARCH env override', () => {
    process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES_SEARCH = '1000';
    const bigHtml = 'y'.repeat(10_000);
    const result = applySearchFallback(bigHtml);
    expect(result.length).toBe(1000);
  });

  it('fetch truncation is unaffected by KUBECLAW_MAX_TOOL_OUTPUT_BYTES_SEARCH', () => {
    process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES_SEARCH = '1000';
    // fetch cap remains at default 50000
    const bigText = 'z'.repeat(100_000);
    const result = applyFetchTruncation(bigText);
    expect(result.length).toBe(50_000);
  });
});
