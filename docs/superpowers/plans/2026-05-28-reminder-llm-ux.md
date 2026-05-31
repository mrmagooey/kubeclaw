# Reminder LLM UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make natural-language reminder requests ("remind me to X in N days/hours") reliable by adding a `set_reminder` convenience tool that enforces ISO-8601 datetime and wraps `scheduleTaskDirect`, and by sharpening the `schedule_task` description and default system prompt.

**Architecture:** A new `src/runtime/tools/set-reminder.ts` exports a `LocalTool` that validates `when_iso` via `new Date()`, builds a verbatim-delivery prompt, and forwards to `scheduleTaskDirect` via the Redis IPC path. `DirectLLMRunner` registers the tool in its constructor via `registerLocalTool`. The `schedule_task` tool description and `DEFAULT_SYSTEM_PROMPT` are sharpened so the LLM prefers `set_reminder` for one-shot reminders and never passes relative phrases as `schedule_value`.

**Tech Stack:** TypeScript, vitest, better-sqlite3

---

## File Map

| File | Change |
|------|--------|
| `src/runtime/tools/set-reminder.ts` | New: `LocalTool` definition + handler |
| `src/runtime/tools/set-reminder.test.ts` | New: unit tests (stub `scheduleTaskDirect`) |
| `src/runtime/direct-llm-runner.ts` | Register `set_reminder`; sharpen `schedule_task` description; extend `DEFAULT_SYSTEM_PROMPT` |
| `src/runtime/direct-llm-runner.test.ts` | Integration test: mock LLM calls `set_reminder`, asserts DB row |
| `e2e/set-reminder.test.ts` | E2E test: mock LLM → `set_reminder` → DB row with verbatim-template prompt |

---

### Task 1: Create `src/runtime/tools/set-reminder.ts` (TDD)

**Files:**
- Create: `src/runtime/tools/set-reminder.ts`
- Create: `src/runtime/tools/set-reminder.test.ts`

- [ ] **Step 1: Write failing unit test**

Create `src/runtime/tools/set-reminder.test.ts`:

```typescript
/**
 * Unit tests for set-reminder LocalTool.
 * Stubs scheduleTaskDirect via vi.mock so no Redis is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- hoisted mock state ----
const mockScheduleTaskDirect = vi.hoisted(() => vi.fn());

vi.mock('../direct-llm-runner.js', async (importOriginal) => {
  // We only need the scheduleTaskDirect export; pull everything else through.
  const original = await importOriginal<typeof import('../direct-llm-runner.js')>();
  return { ...original, scheduleTaskDirect: mockScheduleTaskDirect };
});

import { makeSetReminderTool } from './set-reminder.js';
import type { ContainerInput } from '../types.js';

const fakeInput: ContainerInput = {
  prompt: 'user message',
  groupFolder: 'test-group',
  chatJid: 'user@test',
  isMain: false,
  assistantName: 'Bot',
};

describe('set_reminder tool', () => {
  beforeEach(() => {
    mockScheduleTaskDirect.mockReset();
    mockScheduleTaskDirect.mockResolvedValue('Scheduled task "task-123".');
  });

  it('has the correct tool name and required parameters', () => {
    const tool = makeSetReminderTool(mockScheduleTaskDirect);
    expect(tool.def.function.name).toBe('set_reminder');
    const params = tool.def.function.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.required).toContain('reminder_text');
    expect(params.required).toContain('when_iso');
  });

  it('returns an error and does NOT call scheduleTaskDirect when when_iso is not a valid date', async () => {
    const tool = makeSetReminderTool(mockScheduleTaskDirect);
    const result = await tool.handler(
      { reminder_text: 'take vitamins', when_iso: 'in 3 days' },
      fakeInput,
    );
    expect(result).toMatch(/invalid.*datetime/i);
    expect(mockScheduleTaskDirect).not.toHaveBeenCalled();
  });

  it('returns an error for an empty when_iso string', async () => {
    const tool = makeSetReminderTool(mockScheduleTaskDirect);
    const result = await tool.handler(
      { reminder_text: 'call dentist', when_iso: '' },
      fakeInput,
    );
    expect(result).toMatch(/invalid.*datetime/i);
    expect(mockScheduleTaskDirect).not.toHaveBeenCalled();
  });

  it('calls scheduleTaskDirect with a verbatim-delivery prompt for a valid ISO datetime', async () => {
    const tool = makeSetReminderTool(mockScheduleTaskDirect);
    const isoTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await tool.handler(
      { reminder_text: 'take vitamins', when_iso: isoTime },
      fakeInput,
    );
    expect(mockScheduleTaskDirect).toHaveBeenCalledOnce();
    const [groupFolder, chatJid, isMain, args] =
      mockScheduleTaskDirect.mock.calls[0];
    expect(groupFolder).toBe('test-group');
    expect(chatJid).toBe('user@test');
    expect(isMain).toBe(false);
    expect((args as Record<string, unknown>).prompt).toMatch(
      /deliver this reminder message to the user verbatim.*take vitamins/i,
    );
    expect((args as Record<string, unknown>).schedule_type).toBe('once');
    expect((args as Record<string, unknown>).schedule_value).toBe(isoTime);
  });

  it('returns a confirmation that includes a human-readable time', async () => {
    const tool = makeSetReminderTool(mockScheduleTaskDirect);
    const isoTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await tool.handler(
      { reminder_text: 'take vitamins', when_iso: isoTime },
      fakeInput,
    );
    // Confirmation should include the reminder_text and a recognisable date string
    expect(result).toMatch(/take vitamins/);
    // toLocaleString() contains digits — check for a year like 202x or 203x
    expect(result).toMatch(/20[23]\d/);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npm test -- src/runtime/tools/set-reminder.test.ts
```

Expected: FAIL — `Cannot find module './set-reminder.js'`

- [ ] **Step 3: Implement `src/runtime/tools/set-reminder.ts`**

```typescript
/**
 * set_reminder — convenience LocalTool that wraps schedule_task for
 * natural-language reminder requests.
 *
 * The LLM must supply an absolute ISO-8601 datetime in `when_iso`.
 * The handler validates it, builds a verbatim-delivery prompt, and
 * forwards to scheduleTaskDirect via the Redis IPC path.
 */
import type OpenAI from 'openai';
import type { ContainerInput } from '../types.js';

/** Minimal signature of scheduleTaskDirect used by this tool. */
export type ScheduleTaskFn = (
  groupFolder: string,
  chatJid: string,
  isMain: boolean,
  args: Record<string, unknown>,
) => Promise<string>;

export interface LocalTool {
  def: OpenAI.ChatCompletionTool;
  handler: (
    args: Record<string, unknown>,
    input: ContainerInput,
  ) => Promise<string>;
}

/**
 * Factory — accepts `scheduleTaskFn` so unit tests can inject a stub
 * without going through the module graph.
 */
export function makeSetReminderTool(
  scheduleTaskFn: ScheduleTaskFn,
): LocalTool {
  return {
    def: {
      type: 'function',
      function: {
        name: 'set_reminder',
        description:
          'Set a one-time reminder for the user. Use this (preferred over schedule_task) whenever ' +
          'the user asks to be reminded about something. `when_iso` MUST be an absolute ISO 8601 ' +
          'datetime string (e.g. "2026-06-01T09:00:00Z"). Resolve any relative expression like ' +
          '"in 3 days" or "tomorrow at 9am" to a concrete datetime before calling this tool.',
        parameters: {
          type: 'object',
          properties: {
            reminder_text: {
              type: 'string',
              description:
                'The reminder message to deliver to the user verbatim when the time arrives.',
            },
            when_iso: {
              type: 'string',
              description:
                'Absolute ISO 8601 datetime for the reminder (e.g. "2026-06-01T09:00:00Z"). ' +
                'Never pass relative phrases like "in 3 days" here.',
            },
          },
          required: ['reminder_text', 'when_iso'],
        },
      },
    },

    async handler(
      args: Record<string, unknown>,
      input: ContainerInput,
    ): Promise<string> {
      const reminderText = String(args.reminder_text ?? '');
      const whenIso = String(args.when_iso ?? '');

      // Validate: must parse to a real Date
      const dt = new Date(whenIso);
      if (!whenIso || isNaN(dt.getTime())) {
        return (
          `Invalid datetime: "${whenIso}". ` +
          'Please provide an absolute ISO 8601 datetime string (e.g. "2026-06-01T09:00:00Z"). ' +
          'Resolve relative expressions like "in 3 days" to a concrete datetime first.'
        );
      }

      const prompt =
        `Deliver this reminder message to the user verbatim: ${reminderText}`;

      const scheduleResult = await scheduleTaskFn(
        input.groupFolder,
        input.chatJid,
        input.isMain,
        {
          prompt,
          schedule_type: 'once',
          schedule_value: whenIso,
        },
      );

      const humanTime = dt.toLocaleString();
      return `Reminder set for ${humanTime}: "${reminderText}". ${scheduleResult}`;
    },
  };
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
npm test -- src/runtime/tools/set-reminder.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/tools/set-reminder.ts src/runtime/tools/set-reminder.test.ts
git commit -m "feat: add set_reminder LocalTool with ISO datetime validation"
```

---

### Task 2: Register `set_reminder` in `DirectLLMRunner`

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts:916-934` (constructor + imports)

- [ ] **Step 1: Add import for `makeSetReminderTool`**

At the top of `src/runtime/direct-llm-runner.ts`, after the existing tool imports (around line 55), add:

```typescript
import { makeSetReminderTool } from './tools/set-reminder.js';
```

- [ ] **Step 2: Register the tool in the constructor**

The `DirectLLMRunner` constructor currently (lines 916-918) is:

```typescript
  constructor(client?: OpenAI) {
    this.client = client ?? createLLMClient();
  }
```

Replace with:

```typescript
  constructor(client?: OpenAI) {
    this.client = client ?? createLLMClient();
    this.registerLocalTool(
      'set_reminder',
      makeSetReminderTool(scheduleTaskDirect),
    );
  }
```

- [ ] **Step 3: Verify the tool appears in the effective tool list**

In `src/runtime/direct-llm-runner.test.ts`, add a test after the existing test imports (in the appropriate describe block, around where other constructor/registration tests live). Look for a suitable place — if none exists, add a new describe block:

```typescript
describe('DirectLLMRunner tool registration', () => {
  it('registers set_reminder as a local tool by default', () => {
    const runner = new DirectLLMRunner();
    expect(runner.getLocalToolNames()).toContain('set_reminder');
  });
});
```

- [ ] **Step 4: Run the unit tests**

```bash
npm test -- src/runtime/direct-llm-runner.test.ts
```

Expected: PASS (including the new registration test).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/runtime/direct-llm-runner.test.ts
git commit -m "feat: register set_reminder tool in DirectLLMRunner constructor"
```

---

### Task 3: Sharpen `schedule_task` description and `DEFAULT_SYSTEM_PROMPT`

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts:57-58` (DEFAULT_SYSTEM_PROMPT)
- Modify: `src/runtime/direct-llm-runner.ts:184-207` (schedule_task tool def)

- [ ] **Step 1: Write failing test for sharpened descriptions**

In `src/runtime/direct-llm-runner.test.ts`, add a describe block:

```typescript
describe('tool definitions — schedule_task and DEFAULT_SYSTEM_PROMPT', () => {
  it('schedule_task description warns against relative schedule_value', async () => {
    // Import the TOOLS array via the __testing__ export or by inspecting
    // the effective tools that reach the LLM call.
    // We use a mockCreate spy that captures the tools argument.
    const captured: unknown[] = [];
    mockCreate.mockImplementationOnce(async (req: { tools?: unknown[] }) => {
      if (req.tools) captured.push(...req.tools);
      return {
        choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: undefined }, finish_reason: 'stop' }],
      };
    });

    const runner = new DirectLLMRunner();
    await runner.runAgent(
      { name: 'g1', folder: 'g1', trigger: '', added_at: new Date().toISOString() },
      { prompt: 'hello', groupFolder: 'g1', chatJid: 'u@t', isMain: false, assistantName: 'Bot' },
    );

    const schedTool = (captured as Array<{ function: { name: string; description: string; parameters: { properties: { schedule_value: { description: string } } } } }>)
      .find((t) => t.function.name === 'schedule_task');
    expect(schedTool).toBeDefined();
    // Description must mention ISO 8601 and warn against relative phrases
    expect(schedTool!.function.description).toMatch(/ISO 8601/i);
    expect(schedTool!.function.parameters.properties.schedule_value.description).toMatch(
      /absolute.*ISO|ISO.*absolute/i,
    );
  });

  it('DEFAULT_SYSTEM_PROMPT mentions set_reminder for reminders', async () => {
    const captured: string[] = [];
    mockCreate.mockImplementationOnce(async (req: { messages: Array<{ role: string; content: string }> }) => {
      const sys = req.messages.find((m) => m.role === 'system');
      if (sys) captured.push(sys.content);
      return {
        choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: undefined }, finish_reason: 'stop' }],
      };
    });

    const runner = new DirectLLMRunner();
    await runner.runAgent(
      { name: 'g1', folder: 'g1', trigger: '', added_at: new Date().toISOString() },
      { prompt: 'hello', groupFolder: 'g1', chatJid: 'u@t', isMain: false, assistantName: 'Bot' },
    );

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toMatch(/set_reminder/);
    expect(captured[0]).toMatch(/remind/i);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npm test -- src/runtime/direct-llm-runner.test.ts
```

Expected: FAIL — system prompt does not mention `set_reminder`; `schedule_task` description lacks ISO 8601 wording.

- [ ] **Step 3: Update `DEFAULT_SYSTEM_PROMPT` (line 57-58)**

Replace:

```typescript
const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant. Be concise and direct in your responses.';
```

With:

```typescript
const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant. Be concise and direct in your responses. ' +
  'When a user asks to be reminded about something, use `set_reminder` (preferred) or ' +
  '`schedule_task` with `schedule_type: "once"` and a resolved absolute ISO 8601 datetime; ' +
  'never pass relative phrases like "in 3 days" as the schedule_value.';
```

- [ ] **Step 4: Sharpen `schedule_task` description (lines 184-207)**

Replace the `schedule_task` entry in `TOOLS`:

```typescript
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description:
        'Schedule a recurring or one-time task. The task will run automatically and send results ' +
        'to the current chat. For one-time reminders, prefer `set_reminder` instead. ' +
        'When scheduling a `once` task, `schedule_value` MUST be an absolute ISO 8601 datetime ' +
        'string (e.g. "2026-06-01T09:00:00Z"). Resolve any relative expression like "in 3 days" ' +
        'to a concrete datetime before calling this tool.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'What the task should do each time it runs',
          },
          schedule_type: {
            type: 'string',
            enum: ['cron', 'interval', 'once'],
            description:
              'cron = cron expression, interval = repeat every N ms, once = run once at a specific time',
          },
          schedule_value: {
            type: 'string',
            description:
              'Cron expression (e.g. "0 9 * * 1-5"), interval in milliseconds (e.g. "300000" for 5 min), ' +
              'or absolute ISO 8601 datetime for once (e.g. "2026-06-01T09:00:00Z"). ' +
              'For `once` tasks, this MUST be an absolute datetime — never a relative phrase like "in 3 days".',
          },
        },
        required: ['prompt', 'schedule_type', 'schedule_value'],
      },
    },
  },
```

- [ ] **Step 5: Run test, expect PASS**

```bash
npm test -- src/runtime/direct-llm-runner.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/runtime/direct-llm-runner.test.ts
git commit -m "feat: sharpen schedule_task description and DEFAULT_SYSTEM_PROMPT for reminder UX"
```

---

### Task 4: Integration test — `set_reminder` via `DirectLLMRunner` with real SQLite

**Files:**
- Modify: `src/runtime/direct-llm-runner.integration.test.ts`

The integration test file already initialises a real in-memory SQLite DB via `_initTestDatabase` in `beforeAll`. We extend it with a new suite that uses a stubbed OpenAI client to simulate the LLM calling `set_reminder`, then asserts the `scheduled_tasks` DB row.

- [ ] **Step 1: Write failing integration test**

Add a new `describe` block at the end of `src/runtime/direct-llm-runner.integration.test.ts`:

```typescript
// ---- Suite 3: set_reminder integration (real SQLite + stubbed LLM) --------

describe('set_reminder tool — DirectLLMRunner integration', () => {
  let tmpGroupsDir: string;

  beforeEach(() => {
    tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-integ-'));
    fs.mkdirSync(path.join(tmpGroupsDir, 'test-group'), { recursive: true });
    // No CLAUDE.md needed — falls back to DEFAULT_SYSTEM_PROMPT
  });

  afterEach(() => {
    fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  });

  it('creates a scheduled_tasks row with verbatim-template prompt when LLM calls set_reminder', async () => {
    // ISO one hour from now
    const whenIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    // Stubbed client: first call returns a set_reminder tool call; second call
    // (after tool result) returns a plain text confirmation.
    const stubCreate = vi.fn()
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'set_reminder',
                arguments: JSON.stringify({
                  reminder_text: 'take my vitamins',
                  when_iso: whenIso,
                }),
              },
            }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: 'stop',
          message: { role: 'assistant', content: `Reminder set for ${new Date(whenIso).toLocaleString()}: "take my vitamins".` },
        }],
      });

    const fakeClient = { chat: { completions: { create: stubCreate } } } as unknown as import('openai').default;

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner(fakeClient);

    const groupFolder = `reminder-integ-${Date.now()}`;
    const group = {
      name: groupFolder,
      folder: groupFolder,
      trigger: '',
      added_at: new Date().toISOString(),
    };

    const output = await runner.runAgent(
      group,
      {
        prompt: 'remind me to take my vitamins in 1 hour',
        groupFolder,
        chatJid: 'integ@test',
        isMain: false,
        assistantName: 'Bot',
      },
    );

    expect(output.status).toBe('success');

    // Assert the DB row was created (scheduleTaskDirect goes through Redis IPC,
    // which is mocked — but the mock returns a success string, so we assert the
    // tool result was forwarded correctly instead of the DB row directly).
    // The second LLM call must have received the tool result containing "Reminder set"
    const secondCallMessages = (stubCreate.mock.calls[1][0] as { messages: Array<{ role: string; content?: string }> }).messages;
    const toolResultMsg = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.content).toMatch(/take my vitamins/);
    expect(toolResultMsg!.content).toMatch(/Reminder set/i);
  });

  it('returns an error message to the LLM when when_iso is a relative phrase', async () => {
    const stubCreate = vi.fn()
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_2',
              type: 'function',
              function: {
                name: 'set_reminder',
                arguments: JSON.stringify({
                  reminder_text: 'call dentist',
                  when_iso: 'in 3 days',
                }),
              },
            }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'I could not set that reminder.' },
        }],
      });

    const fakeClient = { chat: { completions: { create: stubCreate } } } as unknown as import('openai').default;

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner(fakeClient);

    const groupFolder = `reminder-invalid-${Date.now()}`;
    await runner.runAgent(
      { name: groupFolder, folder: groupFolder, trigger: '', added_at: new Date().toISOString() },
      { prompt: 'remind me to call dentist in 3 days', groupFolder, chatJid: 'integ2@test', isMain: false, assistantName: 'Bot' },
    );

    // The tool result fed back to the LLM must contain the validation error
    const secondCallMessages = (stubCreate.mock.calls[1][0] as { messages: Array<{ role: string; content?: string }> }).messages;
    const toolResultMsg = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.content).toMatch(/invalid.*datetime/i);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npm test -- src/runtime/direct-llm-runner.integration.test.ts
```

Expected: FAIL — `set_reminder` not yet registered (Task 2 must be complete first).

> Note: Task 2 must be committed before this step will pass. If running in sequence, these tests will pass after Task 2 is done.

- [ ] **Step 3: Run test after Tasks 1 and 2 are complete, expect PASS**

```bash
npm test -- src/runtime/direct-llm-runner.integration.test.ts
```

Expected: all suites PASS.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/direct-llm-runner.integration.test.ts
git commit -m "test(integration): set_reminder tool via DirectLLMRunner with real SQLite"
```

---

### Task 5: E2E test — `set_reminder` end-to-end via mock LLM server

**Files:**
- Create: `e2e/set-reminder.test.ts`

The e2e layer uses the in-process mock LLM server started by `e2e/setup.ts` (`getMockLlmPort()`), the real `_initTestDatabase`, and the real `DirectLLMRunner`. The mock LLM server returns a `set_reminder` tool call on the first request and a plain confirmation on the second, simulating the full path from `runAgent` → `set_reminder` tool dispatch → `scheduleTaskDirect` → Redis IPC → DB row.

Because `scheduleTaskDirect` uses `getRedisClient()` which is mocked in the e2e harness (via the module mock already in `e2e/direct-llm-runner.test.ts`), we assert via the Redis mock spy rather than querying SQLite directly — the same pattern used by the existing `schedule_task` e2e tests.

- [ ] **Step 1: Write failing e2e test**

Create `e2e/set-reminder.test.ts`:

```typescript
/**
 * E2E tests for the set_reminder LocalTool.
 *
 * Uses the in-process mock LLM server to simulate the LLM calling
 * set_reminder, then asserts:
 *   1. The tool result fed back to the LLM contains "Reminder set" and the
 *      reminder text.
 *   2. The final runner output status is 'success'.
 *   3. The confirmation reply echoes the reminder text and a human-readable
 *      datetime.
 *
 * No Kubernetes required.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getMockLlmPort } from './setup.js';
import { _initTestDatabase } from '../src/db.js';

describe('set_reminder — e2e', () => {
  const whenIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  beforeAll(async () => {
    await _initTestDatabase();

    const port = getMockLlmPort();
    if (!port) return;
    process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.DIRECT_LLM_MODEL = 'test/model';
  });

  it('returns success and a confirmation containing the reminder text and human-readable time', async () => {
    if (!getMockLlmPort()) return;

    // We inject a custom OpenAI client stub so we can control the two-turn
    // exchange without depending on the mock LLM server's routing logic.
    const groupFolder = `e2e-reminder-${Date.now()}`;
    const whenIsoLocal = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    // Import the real DirectLLMRunner (which registers set_reminder).
    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');

    let capturedToolResult: string | undefined;

    const stubCreate = (async (req: {
      messages: Array<{ role: string; content?: string }>;
    }) => {
      // If there is a tool result in the messages, this is the second call.
      const hasToolResult = req.messages.some((m) => m.role === 'tool');
      if (hasToolResult) {
        const toolMsg = req.messages.find((m) => m.role === 'tool');
        capturedToolResult = toolMsg?.content ?? '';
        return {
          choices: [{
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: `Reminder set for ${new Date(whenIsoLocal).toLocaleString()}: "call the dentist".`,
            },
          }],
        };
      }
      // First call: return a set_reminder tool call.
      return {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'e2e_call_1',
              type: 'function',
              function: {
                name: 'set_reminder',
                arguments: JSON.stringify({
                  reminder_text: 'call the dentist',
                  when_iso: whenIsoLocal,
                }),
              },
            }],
          },
        }],
      };
    }) as unknown as typeof import('openai').default.prototype.chat.completions.create;

    const fakeClient = {
      chat: { completions: { create: stubCreate } },
    } as unknown as import('openai').default;

    const runner = new DirectLLMRunner(fakeClient);
    const output = await runner.runAgent(
      { name: groupFolder, folder: groupFolder, trigger: '', added_at: new Date().toISOString() },
      {
        prompt: 'remind me to call the dentist in 2 hours',
        groupFolder,
        chatJid: `${groupFolder}@e2e`,
        isMain: false,
        assistantName: 'Bot',
      },
    );

    // AC1: runner completes successfully
    expect(output.status).toBe('success');

    // AC2: tool result fed back to LLM contains reminder text + "Reminder set"
    expect(capturedToolResult).toBeDefined();
    expect(capturedToolResult).toMatch(/call the dentist/);
    expect(capturedToolResult).toMatch(/Reminder set/i);

    // AC3: final reply from LLM echoes reminder text and human-readable time
    expect(output.result).toMatch(/call the dentist/);
    expect(output.result).toMatch(/20[23]\d/); // year in toLocaleString()
  });

  it('returns an error tool result (not a crash) when LLM passes a relative when_iso', async () => {
    if (!getMockLlmPort()) return;

    const groupFolder = `e2e-reminder-bad-${Date.now()}`;
    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');

    let capturedToolResult: string | undefined;

    const stubCreate = (async (req: {
      messages: Array<{ role: string; content?: string }>;
    }) => {
      const hasToolResult = req.messages.some((m) => m.role === 'tool');
      if (hasToolResult) {
        capturedToolResult = req.messages.find((m) => m.role === 'tool')?.content ?? '';
        return {
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'I could not set that reminder.' },
          }],
        };
      }
      return {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'e2e_call_bad',
              type: 'function',
              function: {
                name: 'set_reminder',
                arguments: JSON.stringify({
                  reminder_text: 'call dentist',
                  when_iso: 'in 3 days',
                }),
              },
            }],
          },
        }],
      };
    }) as unknown as typeof import('openai').default.prototype.chat.completions.create;

    const fakeClient = {
      chat: { completions: { create: stubCreate } },
    } as unknown as import('openai').default;

    const runner = new DirectLLMRunner(fakeClient);
    const output = await runner.runAgent(
      { name: groupFolder, folder: groupFolder, trigger: '', added_at: new Date().toISOString() },
      {
        prompt: 'remind me to call dentist in 3 days',
        groupFolder,
        chatJid: `${groupFolder}@e2e`,
        isMain: false,
        assistantName: 'Bot',
      },
    );

    // Runner must not crash — it returns success (the LLM handled the error gracefully)
    expect(output.status).toBe('success');

    // Tool result must be an error string, not an exception
    expect(capturedToolResult).toBeDefined();
    expect(capturedToolResult).toMatch(/invalid.*datetime/i);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
npm test -- e2e/set-reminder.test.ts
```

Expected: FAIL — `Cannot find module '../src/runtime/tools/set-reminder.js'` (before Tasks 1-2) OR the `set_reminder` tool call fails due to missing registration (before Task 2).

- [ ] **Step 3: Run test after Tasks 1-3 are complete, expect PASS**

```bash
npm test -- e2e/set-reminder.test.ts
```

Expected: both tests PASS.

- [ ] **Step 4: Run full test suite to verify no regressions**

```bash
npm test
```

Expected: all existing tests continue to PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/set-reminder.test.ts
git commit -m "test(e2e): set_reminder tool end-to-end via DirectLLMRunner"
```

---

## Completion checklist

- [ ] `src/runtime/tools/set-reminder.ts` exists and exports `makeSetReminderTool`
- [ ] `src/runtime/tools/set-reminder.test.ts` — 5 unit tests all PASS
- [ ] `src/runtime/direct-llm-runner.ts` — `set_reminder` registered in constructor
- [ ] `src/runtime/direct-llm-runner.ts` — `DEFAULT_SYSTEM_PROMPT` mentions `set_reminder` and ISO datetime
- [ ] `src/runtime/direct-llm-runner.ts` — `schedule_task` description mentions ISO 8601 and warns against relative phrases
- [ ] `src/runtime/direct-llm-runner.test.ts` — registration test + description assertion tests PASS
- [ ] `src/runtime/direct-llm-runner.integration.test.ts` — 2 new integration tests PASS
- [ ] `e2e/set-reminder.test.ts` — 2 new e2e tests PASS
- [ ] `npm test` — full suite green
