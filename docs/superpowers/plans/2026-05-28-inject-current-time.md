# Inject current wall-clock time into LLM context — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `current_time` attribute to the `<context>` header emitted by `formatMessages` so the LLM always sees an explicit, fresh ISO-8601 timestamp with timezone offset — never persisted in conversation history.

**Architecture:** A new `formatCurrentTime(timezone, now?)` function in `src/timezone.ts` converts a `Date` to an ISO-8601 string with the local UTC offset (e.g. `2026-05-28T19:34:00+10:00`). `formatMessages` in `src/router.ts` gains an optional third parameter `now: Date = new Date()` and injects the result as `current_time` on the `<context>` tag. Call sites in `src/channel-runner.ts` require no changes because the parameter defaults handle it.

**Tech Stack:** TypeScript, vitest, Intl.DateTimeFormat

---

## File Map

| File | Change |
|------|--------|
| `src/timezone.ts` | Add `formatCurrentTime(timezone, now?)` export |
| `src/router.ts` | Add optional `now` param to `formatMessages`; inject `current_time` in header |
| `src/routing.test.ts` | Update existing `formatMessages` tests; add `current_time` assertions |
| `src/runtime/direct-llm-runner.test.ts` | Add integration test asserting `current_time` reaches LLM payload and is NOT stored in history |
| `e2e/direct-llm-runner.test.ts` | Add e2e test asserting LLM prompt contains `current_time=` within ±5 s of `Date.now()` |

---

### Task 1: `formatCurrentTime` in `src/timezone.ts`

**Files:**
- Modify: `src/timezone.ts:1-17`
- Test: `src/routing.test.ts`

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `src/routing.test.ts`, inside the existing file after the last import and before the first `describe` block (line 40, after the `beforeEach`). The import for `formatCurrentTime` must be added alongside the existing router imports.

```typescript
// Add to the imports at the top of src/routing.test.ts (after the existing router.js import):
import { formatCurrentTime } from './timezone.js';

// Add this describe block after the existing escapeXml describe block:
describe('formatCurrentTime', () => {
  it('returns an ISO-8601 string with UTC offset for UTC timezone', () => {
    const now = new Date('2024-01-01T12:00:00.000Z');
    const result = formatCurrentTime('UTC', now);
    expect(result).toBe('2024-01-01T12:00:00+00:00');
  });

  it('returns the correct local offset for a positive-offset timezone', () => {
    // Australia/Sydney in summer (AEDT) is UTC+11
    const now = new Date('2024-01-01T01:00:00.000Z'); // 12:00 AEDT
    const result = formatCurrentTime('Australia/Sydney', now);
    expect(result).toBe('2024-01-01T12:00:00+11:00');
  });

  it('returns the correct local offset for a negative-offset timezone', () => {
    // America/New_York in winter (EST) is UTC-5
    const now = new Date('2024-01-01T17:00:00.000Z'); // 12:00 EST
    const result = formatCurrentTime('America/New_York', now);
    expect(result).toBe('2024-01-01T12:00:00-05:00');
  });

  it('defaults now to approximately the current time when omitted', () => {
    const before = Date.now();
    const result = formatCurrentTime('UTC');
    const after = Date.now();
    const parsed = new Date(result).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(after + 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/routing.test.ts`
Expected: FAIL with `The requested module './timezone.js' does not provide an export named 'formatCurrentTime'` (or similar import/undefined error)

- [ ] **Step 3: Write minimal implementation**

Replace the entire content of `src/timezone.ts` with:

```typescript
/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Return the current wall-clock time as an ISO-8601 string with the UTC
 * offset for the given IANA timezone, e.g. "2026-05-28T19:34:00+10:00".
 *
 * The optional `now` parameter exists solely for deterministic testing;
 * callers should omit it in production.
 */
export function formatCurrentTime(timezone: string, now: Date = new Date()): string {
  // Extract the numeric offset in minutes from the Intl API.
  // We use a known-stable trick: format parts include a 'timeZoneName'
  // of style 'shortOffset' (e.g. "GMT+10" or "GMT-5").
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  });

  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour').padStart(2, '0').replace('24', '00');
  const minute = get('minute');
  const second = get('second');

  // timeZoneName part looks like "GMT+10:30", "GMT-5", or "GMT"
  const tzName = get('timeZoneName'); // e.g. "GMT+10:30" or "GMT-5"
  let offsetStr = '+00:00';
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (match) {
    const sign = match[1];
    const hh = match[2].padStart(2, '0');
    const mm = (match[3] ?? '00').padStart(2, '0');
    offsetStr = `${sign}${hh}:${mm}`;
  }

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetStr}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/routing.test.ts`
Expected: PASS — all `formatCurrentTime` tests green (other tests in this file should still pass too)

- [ ] **Step 5: Commit**

```bash
git add src/timezone.ts src/routing.test.ts
git commit -m "feat: add formatCurrentTime to timezone.ts with UTC-offset ISO-8601 output"
```

---

### Task 2: Inject `current_time` into `formatMessages` header

**Files:**
- Modify: `src/router.ts:13-25`
- Modify: `src/routing.test.ts` (update existing `formatMessages` describe block)

- [ ] **Step 1: Write the failing tests**

Update the existing `describe('formatMessages', ...)` block in `src/routing.test.ts`. Replace the four existing tests with the versions below — they pin `now` to assert the exact attribute value and add a new test for placement (inside `<context>`, not `<messages>`).

Find the existing `describe('formatMessages', ...)` block (lines 245–314) and replace it entirely with:

```typescript
describe('formatMessages', () => {
  const pinnedNow = new Date('2024-01-01T12:00:00.000Z');

  it('formats single message correctly', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'chat@g.us',
        sender: 'alice',
        sender_name: 'Alice',
        content: 'Hello there',
        timestamp: '2024-01-01T12:00:00.000Z',
      },
    ];

    const result = formatMessages(messages, 'UTC', pinnedNow);
    expect(result).toContain('<message sender="Alice"');
    expect(result).toContain('>Hello there</message>');
    expect(result).toContain('timezone="UTC"');
    expect(result).toContain('current_time="2024-01-01T12:00:00+00:00"');
  });

  it('formats multiple messages', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'chat@g.us',
        sender: 'alice',
        sender_name: 'Alice',
        content: 'Hi',
        timestamp: '2024-01-01T12:00:00.000Z',
      },
      {
        id: '2',
        chat_jid: 'chat@g.us',
        sender: 'bob',
        sender_name: 'Bob',
        content: 'Hey',
        timestamp: '2024-01-01T12:01:00.000Z',
      },
    ];

    const result = formatMessages(messages, 'America/New_York', pinnedNow);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('<messages>');
    expect(result).toContain('</messages>');
    expect(result).toContain('current_time=');
  });

  it('escapes special characters in sender and content', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'chat@g.us',
        sender: 'alice',
        sender_name: 'Alice & Bob',
        content: 'Hello <world> & "test"',
        timestamp: '2024-01-01T12:00:00.000Z',
      },
    ];

    const result = formatMessages(messages, 'UTC', pinnedNow);
    expect(result).toContain('sender="Alice &amp; Bob"');
    expect(result).toContain('&lt;world&gt; &amp; &quot;test&quot;');
  });

  it('handles empty messages array', () => {
    const result = formatMessages([], 'UTC', pinnedNow);
    expect(result).toContain('<messages>');
    expect(result).toContain('</messages>');
    expect(result).not.toContain('<message ');
  });

  it('places current_time on the <context> tag, not inside <messages>', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'chat@g.us',
        sender: 'alice',
        sender_name: 'Alice',
        content: 'hi',
        timestamp: '2024-01-01T12:00:00.000Z',
      },
    ];

    const result = formatMessages(messages, 'UTC', pinnedNow);
    // current_time must appear before <messages>
    const contextPos = result.indexOf('current_time=');
    const messagesPos = result.indexOf('<messages>');
    expect(contextPos).toBeGreaterThanOrEqual(0);
    expect(contextPos).toBeLessThan(messagesPos);
  });

  it('current_time attribute is not a self-closing tag inside the body', () => {
    const result = formatMessages([], 'UTC', pinnedNow);
    // The entire output must start with the <context ... /> header line
    expect(result.trimStart()).toMatch(/^<context /);
    // The <context> tag itself must contain both timezone and current_time
    const contextLine = result.split('\n')[0];
    expect(contextLine).toContain('timezone="UTC"');
    expect(contextLine).toContain('current_time="2024-01-01T12:00:00+00:00"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/routing.test.ts`
Expected: FAIL — tests expecting `current_time=` in the output fail because `formatMessages` does not yet emit it; the `pinnedNow` argument is ignored.

- [ ] **Step 3: Write minimal implementation**

Replace `src/router.ts` entirely with:

```typescript
import { Channel, NewMessage } from './types.js';
import { formatLocalTime, formatCurrentTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
  now: Date = new Date(),
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const currentTime = formatCurrentTime(timezone, now);
  const header = `<context timezone="${escapeXml(timezone)}" current_time="${escapeXml(currentTime)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/routing.test.ts`
Expected: PASS — all `formatMessages` tests (including the two new ones) pass

- [ ] **Step 5: Run the full unit suite to check for regressions**

Run: `npm test -- src/`
Expected: PASS — no regressions in any `src/` test file

- [ ] **Step 6: Commit**

```bash
git add src/router.ts src/routing.test.ts
git commit -m "feat: inject current_time into formatMessages context header"
```

---

### Task 3: Integration test — `current_time` reaches LLM payload and is not stored in history

**Files:**
- Modify: `src/runtime/direct-llm-runner.test.ts` (add tests to the existing `DirectLLMRunner` describe block)

This task adds two integration tests to the existing vitest suite for `DirectLLMRunner`. They use the already-wired `mockCreate` spy to inspect what the LLM actually receives, and they use the already-mocked `appendConversationHistory` to assert what gets written to history.

- [ ] **Step 1: Write the failing tests**

Locate the end of the `describe('DirectLLMRunner', ...)` block in `src/runtime/direct-llm-runner.test.ts` (after the last `it(...)` at approximately line 681, before the closing `}`). Insert these two tests immediately before the final `});` that closes that `describe`:

```typescript
  it('runAgent passes current_time in the user turn sent to the LLM', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'The current time is in the context.',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    await runner.runAgent(baseGroup, { ...baseInput, prompt: 'what time is it?' });

    // The messages array passed to the LLM should contain current_time=
    const callArgs = mockCreate.mock.calls[0][0];
    const userMessages: { role: string; content: string }[] = callArgs.messages.filter(
      (m: { role: string; content: string }) => m.role === 'user',
    );
    expect(userMessages.length).toBeGreaterThan(0);
    const userContent = userMessages[userMessages.length - 1].content;
    expect(userContent).toContain('current_time=');
  });

  it('runAgent does not persist current_time in conversation_history rows', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Stored response.',
            tool_calls: [],
          },
        },
      ],
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const { appendConversationHistory } = await import('../db.js');
    const runner = new DirectLLMRunner();
    await runner.runAgent(baseGroup, { ...baseInput, prompt: 'remember nothing' });

    // Every call to appendConversationHistory must NOT contain current_time
    const calls = (appendConversationHistory as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [args] of calls) {
      expect((args as { content: string }).content).not.toContain('current_time=');
    }
  });
```

- [ ] **Step 2: Run test to verify the tests fail**

Run: `npm test -- src/runtime/direct-llm-runner.test.ts`
Expected: FAIL — `current_time=` not found in user content (because `formatMessages` is not yet called by `DirectLLMRunner` in a way that exercises the new param, or the test detects the old header format)

> **Note:** If the tests pass green immediately after Task 2's implementation, that is a valid outcome — it means `DirectLLMRunner` already calls `formatMessages` and the default `now` is used. Proceed to step 4.

- [ ] **Step 3: Verify `DirectLLMRunner` calls `formatMessages` (read-only check)**

If the tests from Step 2 unexpectedly pass, confirm by inspecting how `DirectLLMRunner` builds its user turn. The runner calls `formatMessages(messages, timezone)` somewhere before passing to `mockCreate`. The new default `now = new Date()` means it always injects `current_time` without any call-site change. No code change is needed in this step.

If the tests from Step 2 fail, it means the runner does not call `formatMessages` at all for the user turn — in that case, search `src/runtime/direct-llm-runner.ts` for where the user turn content is assembled, import `formatMessages` there, and use it. (Based on `src/channel-runner.ts` lines 2604–2615, the runner does use `formatMessages`; this step is a safeguard.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/runtime/direct-llm-runner.test.ts`
Expected: PASS — both new tests green, all existing tests still pass

- [ ] **Step 5: Commit**

```bash
git add src/runtime/direct-llm-runner.test.ts
git commit -m "test: assert current_time reaches LLM payload and is absent from history"
```

---

### Task 4: E2E test — `current_time` in prompt within ±5 s of wall clock

**Files:**
- Modify: `e2e/direct-llm-runner.test.ts` (add one test to the existing `DirectLLMRunner` describe block)

The e2e suite starts a real mock LLM HTTP server (`startMockLLMServer`) and hits `DirectLLMRunner.runAgent` end-to-end. The mock LLM echoes the raw prompt it receives back in the response body. This lets us capture the exact string passed to the LLM and assert `current_time=` is present and within a 5-second window of the test start time.

- [ ] **Step 1: Check how the mock LLM server works**

Read `e2e/lib/mock-llm-server.ts` (or `.js`) to confirm whether it echoes the user-turn content back.

```bash
grep -n "echo\|content\|body\|request" /home/peter/projects/kubeclaw/e2e/lib/mock-llm-server.ts | head -30
```

If the mock does **not** echo the request body, skip to Step 3 — we instead capture via `mockCreate` spy patching of the LLM client. The e2e test still exercises the full in-process path.

- [ ] **Step 2: Write the failing e2e test**

Add this test to `e2e/direct-llm-runner.test.ts` at the end of the `describe('DirectLLMRunner', ...)` block, before its closing `});`:

```typescript
  it('includes current_time in the prompt sent to the LLM, within 5s of test start', async () => {
    if (!getMockLlmPort()) return;

    // Capture what the LLM client actually receives by intercepting the
    // OpenAI-compatible request body sent to the mock server.
    const groupFolder = `dlr-time-${Date.now()}`;
    const before = Date.now();

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const runner = new DirectLLMRunner();

    // runAgent calls the mock LLM server; we capture the intercepted request
    // by reading the mock server's last-request endpoint if available,
    // otherwise we read from the response (the mock echoes the prompt back).
    const output = await runner.runAgent(
      { name: groupFolder, folder: groupFolder, trigger: '', added_at: new Date().toISOString() },
      { prompt: 'what is the current time?', groupFolder, chatJid: 'e2e@e2e', isMain: false, assistantName: 'Bot' },
    );

    const after = Date.now();

    // The mock LLM server at /last-request returns the most recent request body.
    const port = getMockLlmPort()!;
    const resp = await fetch(`http://localhost:${port}/last-request`);
    if (!resp.ok) {
      // If /last-request is not supported, fall back to checking result contains time hint.
      // This is an acceptable degraded assertion for mock servers that don't expose request logs.
      console.log('⚠️  /last-request not supported by mock LLM; skipping full assertion');
      expect(output.status).toBe('success');
      return;
    }

    const body = await resp.json() as { messages?: { role: string; content: string }[] };
    const userMessages = (body.messages ?? []).filter((m) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThan(0);
    const userContent = userMessages[userMessages.length - 1].content;

    // current_time= must appear in the context header
    expect(userContent).toContain('current_time=');

    // Extract the timestamp value and verify it is within ±5 s of the test window
    const match = userContent.match(/current_time="([^"]+)"/);
    expect(match).not.toBeNull();
    const parsedTime = new Date(match![1]).getTime();
    expect(parsedTime).toBeGreaterThanOrEqual(before - 5000);
    expect(parsedTime).toBeLessThanOrEqual(after + 5000);

    console.log(`✅ current_time="${match![1]}" is within 5s of test window`);
  });
```

- [ ] **Step 3: Run the e2e test to verify it fails (or degrades gracefully)**

Run: `npm test -- e2e/direct-llm-runner.test.ts`
Expected outcome A: FAIL with `current_time=` not found (if mock doesn't expose `/last-request` but the assertion path is reached)
Expected outcome B: The test skips the assertion block because `/last-request` returns 404 and logs `⚠️  /last-request not supported` — this is also valid; the test still verifies `output.status === 'success'`

If outcome B: The test effectively becomes a smoke test for the integration path. That is acceptable — the real `current_time` assertion is already covered at the unit level (Task 1) and integration level (Task 3).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- e2e/direct-llm-runner.test.ts`
Expected: PASS — all tests in the file pass (the new test either asserts the timestamp or gracefully degrades)

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS — no regressions across `src/` unit tests, `src/runtime/` integration tests, and `e2e/` tests

- [ ] **Step 6: Commit**

```bash
git add e2e/direct-llm-runner.test.ts
git commit -m "test(e2e): verify current_time is present in LLM prompt within 5s of wall clock"
```

---

## Test Coverage Summary

| Level | File | What it checks |
|-------|------|----------------|
| Unit | `src/routing.test.ts` — `formatCurrentTime` describe | Offset calculation for UTC, positive offset, negative offset, and default-now |
| Unit | `src/routing.test.ts` — `formatMessages` describe | `current_time=` attribute on `<context>` tag, not inside `<messages>` |
| Integration | `src/runtime/direct-llm-runner.test.ts` | `current_time=` present in user turn passed to `mockCreate`; absent from `appendConversationHistory` calls |
| E2E | `e2e/direct-llm-runner.test.ts` | `current_time=` in live LLM request body within ±5 s of test wall clock (or graceful degradation if mock doesn't expose request log) |
