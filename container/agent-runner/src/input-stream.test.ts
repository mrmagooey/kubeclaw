/**
 * Unit tests for InputStreamManager signal distinction.
 *
 * Verifies that:
 *   - hasCloseSignal() returns true only when a 'close' entry is queued
 *   - hasEndOfInput() returns true only when an 'eoi' entry is queued
 *   - drainUserMessages() removes 'message' entries but leaves 'close' and 'eoi'
 */

import { describe, it, expect } from 'vitest';
import { InputStreamManager } from './index.js';

// Deterministic message-id counter — avoids duplicate IDs when fakeXReadResponse
// is called multiple times within the same millisecond.
let _msgIdCounter = 0;

// Build a minimal fake xRead response for a single message with given fields.
function fakeXReadResponse(fields: Record<string, string>) {
  return [
    {
      messages: [
        {
          id: `1000000000000-${_msgIdCounter++}`,
          message: fields,
        },
      ],
    },
  ];
}

describe('InputStreamManager signal distinction', () => {
  it('hasEndOfInput() returns true and hasCloseSignal() returns false when type=eoi is enqueued', () => {
    // @ts-expect-error — pass null for redis/jobId; we drive _enqueue directly
    const manager = new InputStreamManager(null as any, 'test-job-eoi');
    manager._enqueue(fakeXReadResponse({ type: 'eoi' }));

    expect(manager.hasEndOfInput()).toBe(true);
    expect(manager.hasCloseSignal()).toBe(false);
  });

  it('hasCloseSignal() returns true and hasEndOfInput() returns false when type=close is enqueued', () => {
    // @ts-expect-error — pass null for redis/jobId; we drive _enqueue directly
    const manager = new InputStreamManager(null as any, 'test-job-close');
    manager._enqueue(fakeXReadResponse({ type: 'close' }));

    expect(manager.hasCloseSignal()).toBe(true);
    expect(manager.hasEndOfInput()).toBe(false);
  });

  it('drainUserMessages() removes message entries but leaves eoi in the queue', () => {
    // @ts-expect-error — pass null for redis/jobId
    const manager = new InputStreamManager(null as any, 'test-job-drain-eoi');
    manager._enqueue(fakeXReadResponse({ type: 'message', text: 'hello' }));
    manager._enqueue(fakeXReadResponse({ type: 'eoi' }));

    const drained = manager.drainUserMessages();
    expect(drained).toEqual(['hello']);

    // eoi must still be in the queue
    expect(manager.hasEndOfInput()).toBe(true);
  });

  it('drainUserMessages() removes message entries but leaves close in the queue', () => {
    // @ts-expect-error — pass null for redis/jobId
    const manager = new InputStreamManager(null as any, 'test-job-drain-close');
    manager._enqueue(fakeXReadResponse({ type: 'message', text: 'world' }));
    manager._enqueue(fakeXReadResponse({ type: 'close' }));

    const drained = manager.drainUserMessages();
    expect(drained).toEqual(['world']);

    // close must still be in the queue
    expect(manager.hasCloseSignal()).toBe(true);
  });

  it('neither hasCloseSignal() nor hasEndOfInput() fires for a plain message entry', () => {
    // @ts-expect-error — pass null for redis/jobId
    const manager = new InputStreamManager(null as any, 'test-job-message');
    manager._enqueue(fakeXReadResponse({ type: 'message', text: 'ping' }));

    expect(manager.hasCloseSignal()).toBe(false);
    expect(manager.hasEndOfInput()).toBe(false);
  });

  it('both hasCloseSignal() and hasEndOfInput() are true when both eoi and close are enqueued (callers must check close first)', () => {
    // @ts-expect-error — pass null for redis/jobId
    const manager = new InputStreamManager(null as any, 'test-job-both-signals');
    manager._enqueue(fakeXReadResponse({ type: 'eoi' }));
    manager._enqueue(fakeXReadResponse({ type: 'close' }));

    // Both signals are present; the wait-loop checks close before eoi, so close wins.
    expect(manager.hasCloseSignal()).toBe(true);
    expect(manager.hasEndOfInput()).toBe(true);
  });
});
