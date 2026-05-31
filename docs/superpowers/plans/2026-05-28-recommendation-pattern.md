# Recommendation execution pattern — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a `places_search` tool and a recommendation-contract section in the main-channel system prompt so the main agent handles recommendation flows (restaurants, movies, etc.) natively, with multi-turn refinement implicit in the shared `group_folder` session history.

**Architecture:** A `RECOMMENDATION_CONTRACT` constant is defined at module top in `src/runtime/direct-llm-runner.ts` and appended by `loadSystemPrompt` unless the loaded prompt contains the opt-out marker `<!-- no-recommendation-contract -->`. `places_search` is added to the static `TOOLS` array and registered in `TOOL_CATEGORY` (`'browser'`) and `TOOL_SERVER_NAME` (`'placesSearch'`) so it routes to the browser tool pod. A `read_user_profile` local tool is registered via `registerLocalTool` on the `DirectLLMRunner` instance (in `channel-runner.ts`); its handler calls `getGroupProfile` from `src/db.ts` (Plan 2), returning a serialised `GroupProfile` or `{}` if absent. Depends on **Plan 2** (`getGroupProfile` / `upsertGroupProfile` in `src/db.ts`) for profile data access, and on **Plan 9** (`places_search` browser-pod implementation) for the tool to produce real results; both degrade gracefully — `read_user_profile` returns `{}` when no row exists, and `places_search` is safely stubbable in tests.

**Tech Stack:** TypeScript, vitest

---

## Tasks

### Task 1: `RECOMMENDATION_CONTRACT` constant + opt-out in `loadSystemPrompt`

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts:57-58` (add constant after `DEFAULT_SYSTEM_PROMPT`)
- Modify: `src/runtime/direct-llm-runner.ts:862-881` (`loadSystemPrompt` — append contract)
- Modify: `src/runtime/direct-llm-runner.ts:1441-1445` (`__testing__` — no new export needed; `loadSystemPromptForTest` already re-exports `loadSystemPrompt`)
- Test: `src/runtime/direct-llm-runner.test.ts` (extend `loadSystemPrompt — skill composition` describe block)

- [ ] **Step 1: Write failing tests**

Add to the `describe('loadSystemPrompt — skill composition', ...)` block in `src/runtime/direct-llm-runner.test.ts`, after the existing three `it()` cases:

```typescript
  it('appends RECOMMENDATION_CONTRACT when CLAUDE.md does not contain opt-out marker', async () => {
    // CLAUDE.md written in beforeEach as 'BASE PROMPT' — no opt-out marker
    const { __testing__ } = await import('./direct-llm-runner.js');
    const out = __testing__.loadSystemPromptForTest('g1', tmpGroupsDir);
    expect(out).toContain('## Recommendation guidelines');
    expect(out).toContain('read_user_profile');
    expect(out).toContain('places_search');
  });

  it('does NOT append RECOMMENDATION_CONTRACT when CLAUDE.md contains opt-out marker', async () => {
    fs.writeFileSync(
      path.join(tmpGroupsDir, 'g1', 'CLAUDE.md'),
      'CUSTOM PROMPT\n<!-- no-recommendation-contract -->',
    );
    const { __testing__ } = await import('./direct-llm-runner.js');
    const out = __testing__.loadSystemPromptForTest('g1', tmpGroupsDir);
    expect(out).not.toContain('## Recommendation guidelines');
    expect(out).toContain('CUSTOM PROMPT');
  });

  it('appends RECOMMENDATION_CONTRACT when CLAUDE.md is absent (default system prompt)', async () => {
    // Use a group folder that has no CLAUDE.md
    fs.mkdirSync(path.join(tmpGroupsDir, 'g2'), { recursive: true });
    const { __testing__ } = await import('./direct-llm-runner.js');
    const out = __testing__.loadSystemPromptForTest('g2', tmpGroupsDir);
    expect(out).toContain('## Recommendation guidelines');
  });
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `npm test -- src/runtime/direct-llm-runner.test.ts`
Expected: FAIL with `AssertionError: expected '...' to include '## Recommendation guidelines'` (contract not yet injected).

- [ ] **Step 3: Implement — add `RECOMMENDATION_CONTRACT` constant and update `loadSystemPrompt`**

In `src/runtime/direct-llm-runner.ts`, after the existing `DEFAULT_SYSTEM_PROMPT` constant at line 57, insert:

```typescript
const RECOMMENDATION_CONTRACT = `

## Recommendation guidelines

When the user asks for a recommendation (restaurants, films, activities, products, or any
"best X near me / for me" request), follow this contract:

1. **Profile** — call \`read_user_profile\` first. Use the returned fields (location,
   cuisine_likes, cuisine_dislikes, dietary_restrictions, budget_tier) to tailor results.
   If the profile is empty (\`{}\`), ask a single clarifying question about location before
   proceeding.

2. **Search** — call \`places_search\` (or \`web_search\` if \`places_search\` is unavailable)
   with a query that incorporates the user's location and any constraints already known.

3. **Refinement** — if the user adds a constraint ("cheaper", "closer", "vegetarian"),
   re-invoke \`places_search\` with the updated query rather than answering from memory.
   Conversation history already contains the prior results; you do not need to repeat them.

4. **Present results** — return a short ranked list (3–5 items) with:
   - **Name** and address / area
   - One-line reason why it fits this user
   - Source citation (URL or "via places_search")

Do not give a recommendation without calling at least one search tool — hallucinated
restaurant names cause real harm.
`;

/** Opt-out sentinel: if present in CLAUDE.md the recommendation contract is suppressed. */
const RECOMMENDATION_CONTRACT_OPT_OUT = '<!-- no-recommendation-contract -->';
```

Then update `loadSystemPrompt` (lines 862–881) to inject the contract:

```typescript
function loadSystemPrompt(
  groupFolder: string,
  groupsDir: string = GROUPS_DIR,
): string {
  const claudeMd = path.join(groupsDir, groupFolder, 'CLAUDE.md');
  let base = DEFAULT_SYSTEM_PROMPT;
  try {
    const content = fs.readFileSync(claudeMd, 'utf-8');
    if (content.trim()) base = content.trim();
  } catch {
    // file missing — use default
  }

  // Append recommendation contract unless the prompt explicitly opts out.
  const hasOptOut = base.includes(RECOMMENDATION_CONTRACT_OPT_OUT);
  if (!hasOptOut) {
    base = base + RECOMMENDATION_CONTRACT;
  }

  try {
    const { promptSuffix } = loadSkills(groupsDir, groupFolder);
    return promptSuffix ? base + promptSuffix : base;
  } catch (err) {
    logger.warn({ err, groupFolder }, 'skill-loader failed; using base prompt');
    return base;
  }
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test -- src/runtime/direct-llm-runner.test.ts`
Expected: PASS (all `loadSystemPrompt — skill composition` cases green, no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/runtime/direct-llm-runner.test.ts
git commit -m "feat: inject RECOMMENDATION_CONTRACT into system prompt via loadSystemPrompt"
```

---

### Task 2: `places_search` TOOLS entry + `TOOL_CATEGORY`/`TOOL_SERVER_NAME` registration

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts:356-357` (insert after the closing `}` of `propose_skill` entry, before the `];` that closes `TOOLS`)
- Modify: `src/runtime/direct-llm-runner.ts:371-376` (`TOOL_SERVER_NAME` map — add entry)
- Modify: `src/runtime/direct-llm-runner.ts:379-384` (`TOOL_CATEGORY` map — add entry)
- Test: `src/runtime/direct-llm-runner.test.ts` (new `describe('TOOLS — places_search', ...)` block)

- [ ] **Step 1: Write failing tests**

Add a new describe block to `src/runtime/direct-llm-runner.test.ts` after the existing `TOOLS — propose_skill registration` describe block:

```typescript
describe('TOOLS — places_search registration', () => {
  it('includes places_search in the built-in tool list', async () => {
    const { __testing__ } = await import('./direct-llm-runner.js');
    const names = __testing__.toolsForTest().map((t: any) => t.function.name);
    expect(names).toContain('places_search');
  });

  it('places_search tool definition has required query and location parameters', async () => {
    const { __testing__ } = await import('./direct-llm-runner.js');
    const tool = __testing__.toolsForTest().find(
      (t: any) => t.function.name === 'places_search',
    );
    expect(tool).toBeDefined();
    const props = tool!.function.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty('query');
    expect(props).toHaveProperty('location');
    expect(tool!.function.parameters.required).toContain('query');
  });

  it('places_search is mapped to browser category in TOOL_CATEGORY', async () => {
    const { __testing__ } = await import('./direct-llm-runner.js');
    expect(__testing__.toolCategoryForTest('places_search')).toBe('browser');
  });

  it('places_search is mapped to placesSearch in TOOL_SERVER_NAME', async () => {
    const { __testing__ } = await import('./direct-llm-runner.js');
    expect(__testing__.toolServerNameForTest('places_search')).toBe('placesSearch');
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `npm test -- src/runtime/direct-llm-runner.test.ts`
Expected: FAIL — `toolCategoryForTest` and `toolServerNameForTest` are not yet exported, and `places_search` is absent from `TOOLS`.

- [ ] **Step 3: Implement**

**3a.** In `src/runtime/direct-llm-runner.ts`, inside the `TOOLS` array, insert after the closing `},` of the `propose_skill` entry (before the `];` at line 357):

```typescript
  {
    type: 'function',
    function: {
      name: 'places_search',
      description:
        'Search for local places (restaurants, cafés, shops, attractions) near a given location. ' +
        'Returns a ranked list of results with name, address, rating, price tier, and a brief description. ' +
        'Use when the user asks for recommendations for a place to eat, visit, or shop.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'What to search for, e.g. "Italian restaurants", "coffee shops", "bookstores"',
          },
          location: {
            type: 'string',
            description:
              'Where to search, e.g. "Melbourne CBD, Australia", "Brooklyn, NY". ' +
              'Omit to use the profile location if available.',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results to return (default 5, max 10)',
          },
        },
        required: ['query'],
      },
    },
  },
```

**3b.** In `TOOL_SERVER_NAME` (currently ending at line 376), add:

```typescript
  places_search: 'placesSearch',
```

**3c.** In `TOOL_CATEGORY` (currently ending at line 383), add:

```typescript
  places_search: 'browser',
```

**3d.** Extend `__testing__` at the bottom of the file (lines 1441–1445) to expose the maps:

```typescript
export const __testing__ = {
  loadSystemPromptForTest: (group: string, groupsDir: string) =>
    loadSystemPrompt(group, groupsDir),
  toolsForTest: () => TOOLS,
  toolCategoryForTest: (name: string) => TOOL_CATEGORY[name],
  toolServerNameForTest: (name: string) => TOOL_SERVER_NAME[name],
};
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test -- src/runtime/direct-llm-runner.test.ts`
Expected: PASS — all four new `places_search` cases pass, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/runtime/direct-llm-runner.test.ts
git commit -m "feat: add places_search tool to TOOLS, TOOL_CATEGORY, TOOL_SERVER_NAME"
```

---

### Task 3: `read_user_profile` local tool registration

**Files:**
- Create: `src/runtime/tools/read-user-profile.ts`
- Modify: `src/channel-runner.ts` (find where `registerLocalTool` is called for other local tools, or the `DirectLLMRunner` construction site — register `read_user_profile` there)
- Test: `src/runtime/tools/read-user-profile.test.ts` (unit tests for handler)
- Test: `src/runtime/direct-llm-runner.test.ts` (verify registration via `getLocalToolNames()`)

#### Step sequence

- [ ] **Step 1: Write failing unit tests for the handler**

Create `src/runtime/tools/read-user-profile.test.ts`:

```typescript
/**
 * Unit tests for the read_user_profile local tool handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock db.js so the handler never touches SQLite ----
const mockGetGroupProfile = vi.hoisted(() => vi.fn());

vi.mock('../../db.js', () => ({
  getGroupProfile: mockGetGroupProfile,
}));

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// ---- Tests ----------------------------------------------------------------

describe('readUserProfileHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns serialised GroupProfile when a row exists', async () => {
    mockGetGroupProfile.mockReturnValue({
      groupFolder: 'alice-group',
      timezone: 'America/New_York',
      location: 'Brooklyn, NY',
      cuisineLikes: 'Japanese, Thai',
      cuisineDislikes: 'Liver',
      dietaryRestrictions: 'no shellfish',
      budgetTier: 'mid-range',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });

    const { readUserProfileHandler } = await import('./read-user-profile.js');
    const result = await readUserProfileHandler(
      {},
      {
        groupFolder: 'alice-group',
        chatJid: 'alice@test',
        isMain: true,
        prompt: '',
        assistantName: 'Bot',
      },
    );

    const parsed = JSON.parse(result);
    expect(parsed.groupFolder).toBe('alice-group');
    expect(parsed.timezone).toBe('America/New_York');
    expect(parsed.location).toBe('Brooklyn, NY');
    expect(parsed.cuisineLikes).toBe('Japanese, Thai');
    expect(parsed.budgetTier).toBe('mid-range');
    expect(mockGetGroupProfile).toHaveBeenCalledWith('alice-group');
  });

  it('returns "{}" when no profile row exists', async () => {
    mockGetGroupProfile.mockReturnValue(null);

    const { readUserProfileHandler } = await import('./read-user-profile.js');
    const result = await readUserProfileHandler(
      {},
      {
        groupFolder: 'unknown-group',
        chatJid: 'nobody@test',
        isMain: false,
        prompt: '',
        assistantName: 'Bot',
      },
    );

    expect(result).toBe('{}');
    expect(mockGetGroupProfile).toHaveBeenCalledWith('unknown-group');
  });

  it('returns "{}" when getGroupProfile throws (defensive degradation)', async () => {
    mockGetGroupProfile.mockImplementation(() => {
      throw new Error('db not ready');
    });

    const { readUserProfileHandler } = await import('./read-user-profile.js');
    const result = await readUserProfileHandler(
      {},
      {
        groupFolder: 'error-group',
        chatJid: 'x@test',
        isMain: false,
        prompt: '',
        assistantName: 'Bot',
      },
    );

    expect(result).toBe('{}');
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `npm test -- src/runtime/tools/read-user-profile.test.ts`
Expected: FAIL — `Cannot find module './read-user-profile.js'`

- [ ] **Step 3: Create `src/runtime/tools/read-user-profile.ts`**

```typescript
/**
 * read_user_profile — in-process local tool for DirectLLMRunner.
 *
 * Reads the per-group structured user profile via getGroupProfile (Plan 2).
 * Returns a JSON-serialised GroupProfile, or '{}' if no profile row exists or
 * if getGroupProfile is not yet available (graceful degradation pre-Plan-2).
 */
import { getGroupProfile } from '../../db.js';
import { logger } from '../../logger.js';
import type { ContainerInput } from '../types.js';
import type { LocalTool } from '../direct-llm-runner.js';
import OpenAI from 'openai';

export async function readUserProfileHandler(
  _args: Record<string, unknown>,
  input: ContainerInput,
): Promise<string> {
  try {
    const profile = getGroupProfile(input.groupFolder);
    if (!profile) return '{}';
    return JSON.stringify(profile);
  } catch (err) {
    logger.warn({ err, groupFolder: input.groupFolder }, 'read_user_profile: getGroupProfile failed; returning {}');
    return '{}';
  }
}

export const READ_USER_PROFILE_TOOL: LocalTool = {
  def: {
    type: 'function',
    function: {
      name: 'read_user_profile',
      description:
        'Read the stored user profile for this conversation (timezone, location, cuisine preferences, ' +
        'dietary restrictions, budget tier). Call this at the start of any recommendation flow. ' +
        'Returns a JSON object; empty object ({}) means no profile has been set yet.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  } as OpenAI.ChatCompletionTool,
  handler: readUserProfileHandler,
};
```

- [ ] **Step 4: Run handler unit tests, expect PASS**

Run: `npm test -- src/runtime/tools/read-user-profile.test.ts`
Expected: PASS — all three handler cases green.

- [ ] **Step 5: Write failing registration test**

Find where `DirectLLMRunner` is constructed and local tools are registered in `src/channel-runner.ts`. Add `read_user_profile` registration and verify via a unit test. Add a new `it()` at the end of the `describe('DirectLLMRunner', ...)` block in `src/runtime/direct-llm-runner.test.ts`:

```typescript
  it('registerLocalTool makes read_user_profile available via getLocalToolNames', async () => {
    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const { READ_USER_PROFILE_TOOL } = await import('./tools/read-user-profile.js');
    const runner = new DirectLLMRunner();

    runner.registerLocalTool('read_user_profile', READ_USER_PROFILE_TOOL);

    expect(runner.getLocalToolNames()).toContain('read_user_profile');
  });
```

Run: `npm test -- src/runtime/direct-llm-runner.test.ts`
Expected: PASS immediately (since `registerLocalTool` and `getLocalToolNames` already exist; this test is a compile-safety check).

- [ ] **Step 6: Register the tool in `src/channel-runner.ts`**

Locate the `DirectLLMRunner` construction site in `src/channel-runner.ts` (the runner is constructed once per channel pod startup). Find where other local tools are registered (search for existing `runner.registerLocalTool` calls). Insert the `read_user_profile` registration immediately after:

```typescript
import { READ_USER_PROFILE_TOOL } from './runtime/tools/read-user-profile.js';

// ... (inside the block where runner is constructed and local tools are wired) ...
runner.registerLocalTool('read_user_profile', READ_USER_PROFILE_TOOL);
```

- [ ] **Step 7: Run full unit test suite, expect PASS**

Run: `npm test -- src/runtime/`
Expected: PASS — no regressions in the runtime directory tests.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/tools/read-user-profile.ts \
        src/runtime/tools/read-user-profile.test.ts \
        src/runtime/direct-llm-runner.test.ts \
        src/channel-runner.ts
git commit -m "feat: add read_user_profile local tool with {} fallback"
```

---

### Task 4: Integration test — stubbed LLM confirms tool routing and history threading

This is the integration test level. It uses the existing vitest mocking infrastructure in `src/runtime/direct-llm-runner.test.ts` (mocked `openai`, mocked `db.js`) to verify: (a) `places_search` resolves via K8s browser pod, (b) `read_user_profile` resolves in-process, (c) a second `runAgent` call on the same `groupFolder` sees both results in history and the recommendation contract in the system prompt.

**Files:**
- Test: `src/runtime/direct-llm-runner.test.ts` (new `describe('recommendation pattern — integration', ...)` block)

- [ ] **Step 1: Write failing integration tests**

Add a new describe block at the bottom of `src/runtime/direct-llm-runner.test.ts`:

```typescript
describe('recommendation pattern — integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisInstance.xread.mockResolvedValue(null);
  });

  it('read_user_profile local tool is dispatched in-process (no K8s job spawned)', async () => {
    // Turn 1: LLM requests read_user_profile, then answers
    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-rup-1',
                  type: 'function',
                  function: { name: 'read_user_profile', arguments: '{}' },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Here are my top Italian picks for you.',
              tool_calls: [],
            },
          },
        ],
      });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const { READ_USER_PROFILE_TOOL } = await import(
      './tools/read-user-profile.js'
    );
    const { jobRunner } = await import('../k8s/job-runner.js');

    const runner = new DirectLLMRunner();
    runner.registerLocalTool('read_user_profile', READ_USER_PROFILE_TOOL);

    const result = await runner.runAgent(baseGroup, baseInput);

    expect(result.status).toBe('success');
    expect(result.result).toBe('Here are my top Italian picks for you.');
    // read_user_profile must NOT spawn a K8s job
    expect(jobRunner.runToolJob).not.toHaveBeenCalled();
    // Two LLM calls: tool-request turn + final answer turn
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('places_search tool call routes via K8s browser pod (TOOL_CATEGORY=browser)', async () => {
    // Turn 1: LLM requests places_search
    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-ps-1',
                  type: 'function',
                  function: {
                    name: 'places_search',
                    arguments: JSON.stringify({ query: 'Italian restaurants', location: 'Brooklyn, NY' }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Top 3 Italian spots in Brooklyn.',
              tool_calls: [],
            },
          },
        ],
      });

    // Simulate browser pod returning search results
    let capturedRequestId: string | undefined;
    mockRedisInstance.xadd.mockImplementation((...args: unknown[]) => {
      const fields = args.slice(2) as string[];
      const idx = fields.indexOf('requestId');
      if (idx >= 0) capturedRequestId = fields[idx + 1];
      return Promise.resolve('1-0');
    });
    mockRedisInstance.xread.mockImplementation(async () => {
      if (!capturedRequestId) return null;
      return [
        [
          'stream',
          [
            [
              '1-0',
              [
                'requestId',
                capturedRequestId,
                'result',
                JSON.stringify([
                  { name: 'Lucali', address: '575 Henry St', rating: 4.8, price: '$$' },
                ]),
              ],
            ],
          ],
        ],
      ];
    });

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const { jobRunner } = await import('../k8s/job-runner.js');

    const runner = new DirectLLMRunner();
    const result = await runner.runAgent(baseGroup, baseInput);

    expect(result.status).toBe('success');
    // places_search must have triggered a browser pod spawn
    expect(jobRunner.runToolJob).toHaveBeenCalled();
    // The tool job call should reference the browser category stream
    const runCall = (jobRunner.runToolJob as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(runCall).toContain('browser');
  });

  it('second runAgent call on same groupFolder receives recommendation contract in system prompt', async () => {
    // Both turns return plain text — we only care about what was passed to the LLM
    mockCreate
      .mockResolvedValue({
        choices: [
          { message: { role: 'assistant', content: 'ok', tool_calls: [] } },
        ],
      });

    // Stub getConversationHistory to return a prior recommendation exchange
    const { getConversationHistory } = await import('../db.js');
    (getConversationHistory as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: 'user', content: 'good Italian restaurants near me' },
      { role: 'assistant', content: 'Top 3 Italian spots: Lucali...' },
    ]);

    const { DirectLLMRunner } = await import('./direct-llm-runner.js');
    const runner = new DirectLLMRunner();

    await runner.runAgent(baseGroup, {
      ...baseInput,
      prompt: 'cheaper options please',
    });

    const firstCall = mockCreate.mock.calls[0][0];
    // System prompt must include the recommendation contract
    const systemMsg = firstCall.messages.find((m: any) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain('## Recommendation guidelines');
    expect(systemMsg.content).toContain('read_user_profile');
    // History must include the prior exchange
    const userMsgs = firstCall.messages.filter((m: any) => m.role === 'user');
    expect(userMsgs.some((m: any) => m.content?.includes('cheaper options'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `npm test -- src/runtime/direct-llm-runner.test.ts`
Expected: FAIL on the first two cases (tool registration not done in the test yet; `places_search` K8s routing may fail before Task 2 changes land).

After Tasks 1–3 are complete all three should pass.

- [ ] **Step 3: Run tests, expect PASS**

After Tasks 1–3 are complete:

Run: `npm test -- src/runtime/direct-llm-runner.test.ts`
Expected: PASS — all integration cases green.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/direct-llm-runner.test.ts
git commit -m "test: integration tests for recommendation contract, places_search routing, history threading"
```

---

### Task 5: E2E test — full channel turn with recommendation flow

This uses the existing e2e harness from `e2e/direct-llm-runner.test.ts` (in-process mock LLM server, real SQLite via `_initTestDatabase`). The mock LLM server always returns plain text — we configure it to return a `places_search` tool call on the first turn, then a final answer on the second turn, by injecting a sequence via the existing `getMockLlmPort` mechanism. Because the mock LLM always returns plain text (no tool calls) in the current setup, the e2e test asserts the observable behaviors that do not depend on the mock returning tool calls: the system prompt contains the contract, history is threaded across turns, and `read_user_profile` returns `{}` gracefully when no profile exists.

**Files:**
- Create: `e2e/recommendation-pattern.test.ts`

- [ ] **Step 1: Write the e2e test file**

Create `e2e/recommendation-pattern.test.ts`:

```typescript
/**
 * E2E tests for Plan 10: Recommendation execution pattern.
 *
 * Verifies end-to-end observable behaviors:
 *   AC1. System prompt sent to the LLM contains the RECOMMENDATION_CONTRACT section
 *        (## Recommendation guidelines, read_user_profile, places_search).
 *   AC2. `read_user_profile` is registered as a local tool on the runner
 *        (getLocalToolNames returns it).
 *   AC3. When no profile row exists, read_user_profile handler returns '{}' without error.
 *   AC4. Conversation history from a first turn is visible to the second turn's LLM call
 *        (multi-turn refinement threading works).
 *   AC5. `places_search` is present in the tool list advertised to the LLM.
 *
 * Uses the in-process mock LLM server (getMockLlmPort) + real SQLite.
 * No Kubernetes required.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getMockLlmPort } from './setup.js';
import { _initTestDatabase } from '../src/db.js';

describe('Recommendation execution pattern (E2E)', () => {
  beforeAll(async () => {
    await _initTestDatabase();

    const port = getMockLlmPort();
    if (!port) return;
    process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.DIRECT_LLM_MODEL = 'test/model';
  });

  it('AC1: system prompt contains RECOMMENDATION_CONTRACT when no opt-out is present', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { __testing__ } = await import('../src/runtime/direct-llm-runner.js');
    const groupFolder = `rec-contract-${Date.now()}`;

    // No CLAUDE.md written — uses default system prompt, contract should be appended
    const prompt = __testing__.loadSystemPromptForTest(groupFolder, '/tmp/nonexistent-groups');

    expect(prompt).toContain('## Recommendation guidelines');
    expect(prompt).toContain('read_user_profile');
    expect(prompt).toContain('places_search');
    console.log('✅ AC1: RECOMMENDATION_CONTRACT present in system prompt');
  });

  it('AC1 opt-out: system prompt does NOT contain contract when opt-out marker is present', async () => {
    if (!getMockLlmPort()) return;

    import fs from 'fs';
    import os from 'os';
    import path from 'path';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-optout-'));
    const groupFolder = `g-optout`;
    fs.mkdirSync(path.join(tmpDir, groupFolder), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, groupFolder, 'CLAUDE.md'),
      'CUSTOM SYSTEM PROMPT\n<!-- no-recommendation-contract -->',
    );

    try {
      const { __testing__ } = await import('../src/runtime/direct-llm-runner.js');
      const prompt = __testing__.loadSystemPromptForTest(groupFolder, tmpDir);

      expect(prompt).not.toContain('## Recommendation guidelines');
      expect(prompt).toContain('CUSTOM SYSTEM PROMPT');
      console.log('✅ AC1 opt-out: contract suppressed when opt-out marker present');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('AC2: read_user_profile is registered as a local tool on a fresh runner', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { READ_USER_PROFILE_TOOL } = await import(
      '../src/runtime/tools/read-user-profile.js'
    );

    const runner = new DirectLLMRunner();
    runner.registerLocalTool('read_user_profile', READ_USER_PROFILE_TOOL);

    expect(runner.getLocalToolNames()).toContain('read_user_profile');
    console.log('✅ AC2: read_user_profile registered on runner');
  });

  it('AC3: read_user_profile handler returns "{}" when no profile exists', async () => {
    if (!getMockLlmPort()) return;

    const { readUserProfileHandler } = await import(
      '../src/runtime/tools/read-user-profile.js'
    );

    const result = await readUserProfileHandler(
      {},
      {
        groupFolder: `no-profile-group-${Date.now()}`,
        chatJid: 'anon@e2e',
        isMain: false,
        prompt: 'find me a restaurant',
        assistantName: 'Bot',
      },
    );

    expect(result).toBe('{}');
    console.log('✅ AC3: read_user_profile returns {} for unknown group');
  });

  it('AC4: conversation history from first turn is present in second turn LLM context', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { getConversationHistory } = await import('../src/db.js');
    const { READ_USER_PROFILE_TOOL } = await import(
      '../src/runtime/tools/read-user-profile.js'
    );

    const runner = new DirectLLMRunner();
    runner.registerLocalTool('read_user_profile', READ_USER_PROFILE_TOOL);

    const groupFolder = `rec-hist-${Date.now()}`;
    const group = {
      name: groupFolder,
      folder: groupFolder,
      trigger: '',
      added_at: new Date().toISOString(),
    };

    // First turn: "good Italian restaurants near me"
    const turn1 = await runner.runAgent(group, {
      prompt: 'good Italian restaurants near me',
      groupFolder,
      chatJid: 'e2e@e2e',
      isMain: false,
      assistantName: 'Bot',
    });
    expect(turn1.status).toBe('success');

    // Second turn: follow-up refinement
    const turn2 = await runner.runAgent(group, {
      prompt: 'cheaper options please',
      groupFolder,
      chatJid: 'e2e@e2e',
      isMain: false,
      assistantName: 'Bot',
    });
    expect(turn2.status).toBe('success');

    // History must contain both user turns
    const history = getConversationHistory(groupFolder);
    expect(
      history.some((m) => m.content === 'good Italian restaurants near me'),
    ).toBe(true);
    expect(history.some((m) => m.content === 'cheaper options please')).toBe(
      true,
    );
    console.log(`✅ AC4: history has ${history.length} messages across two turns`);
  });

  it('AC5: places_search is in the tool list advertised to the LLM', async () => {
    if (!getMockLlmPort()) return;

    const { __testing__ } = await import('../src/runtime/direct-llm-runner.js');
    const toolNames = __testing__.toolsForTest().map((t: any) => t.function.name);

    expect(toolNames).toContain('places_search');
    // Verify it has the expected parameter shape
    const tool = __testing__.toolsForTest().find(
      (t: any) => t.function.name === 'places_search',
    );
    expect(tool!.function.parameters.properties).toHaveProperty('query');
    console.log('✅ AC5: places_search present in TOOLS with query parameter');
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `npm test -- e2e/recommendation-pattern.test.ts`
Expected: FAIL — import errors for `read-user-profile.js` and `__testing__` exports not yet containing `toolCategoryForTest`/`toolServerNameForTest` (Tasks 1–3 not complete).

After Tasks 1–3 are complete, all five ACs should pass.

- [ ] **Step 3: Fix import style in e2e test (static imports at top)**

Note: the `import fs from 'fs'` statements inside the `it()` body in the draft above must be moved to top-level static imports. Update `e2e/recommendation-pattern.test.ts` to have:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getMockLlmPort } from './setup.js';
import { _initTestDatabase } from '../src/db.js';
```

And remove the `import` statements from inside the `it()` body in AC1 opt-out test (they are already at the top after this step).

- [ ] **Step 4: Run e2e test, expect PASS**

Run: `npm test -- e2e/recommendation-pattern.test.ts`
Expected: PASS — all five ACs green. If the mock LLM port is unavailable the tests skip gracefully via the `if (!getMockLlmPort()) return;` guards.

- [ ] **Step 5: Run full test suite to confirm no regressions**

Run: `npm test`
Expected: PASS — no regressions across unit, integration, or e2e suites.

- [ ] **Step 6: Commit**

```bash
git add e2e/recommendation-pattern.test.ts
git commit -m "test(e2e): recommendation pattern AC1-AC5 — contract, profile tool, history threading"
```

---

## Dependency notes

- **Plan 2 (`2026-05-28-group-profile.md`):** `read_user_profile` handler calls `getGroupProfile` from `src/db.ts`. If Plan 2 is not yet merged, `getGroupProfile` will be missing and the import will fail to compile. In that case, implement Plan 2 first, or stub `getGroupProfile` as `(_: string) => null` in a temporary shim file until Plan 2 lands.
- **Plan 9 (places-search browser-pod implementation):** `places_search` is registered in `TOOL_CATEGORY` as `'browser'`, which routes it to the browser tool pod. If Plan 9 has not landed, `places_search` calls will time out waiting for a pod result. The unit and e2e tests in this plan mock the tool pod path (via `mockRedisInstance.xread`) so they pass regardless.
