# Baseline Researcher specialist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `Researcher` specialist in the Helm chart baseline so that `@researcher` (or `@Researcher`) routes to a web-research sub-agent without any manual operator registration.

**Architecture:** The specialist YAML stanza lives in `helm/kubeclaw/values.yaml` under the `specialists:` key; the existing `specialists-baseline-configmap.yaml` template renders it directly into the `kubeclaw-specialists-baseline` ConfigMap via `{{ toJson .Values.specialists }}`, which the orchestrator's `SpecialistReconciler` then merges into `kubeclaw-specialists` at startup. The new entry uses `memory.isolated: false` so that follow-up `@researcher` turns share the group-folder session, enabling iterative refinement.

**Tech Stack:** YAML, Helm, TypeScript, vitest

---

## Tasks

### Task 1: Unit validation — `validateSpecialist` accepts the Researcher stanza

Confirm that the exact object decoded from the new YAML passes `validateSpecialist` (and therefore `parseSpecialists`). Write the failing test first, then add the YAML, then confirm the test passes.

**Files:**
- Test: `src/specialists/types.test.ts`
- Modify: `helm/kubeclaw/values.yaml`

---

- [ ] **Step 1: Write failing test in `src/specialists/types.test.ts`**

  Add a new `describe` block directly after the existing `parseSpecialists` block:

  ```typescript
  describe('Researcher baseline specialist', () => {
    it('validateSpecialist accepts the full Researcher stanza', () => {
      const researcher = {
        name: 'Researcher',
        prompt:
          'You are a web-research specialist. When given a topic or question:\n' +
          '1. Search for relevant, current information using available search tools.\n' +
          '2. Fetch and read promising sources to gather details.\n' +
          '3. Synthesise findings into a concise, structured summary with:\n' +
          '   - A one-paragraph executive summary.\n' +
          '   - Key facts as a bulleted list.\n' +
          '   - Source URLs cited inline.\n' +
          'Stay factual; note when information is uncertain or conflicting.\n',
        triggers: ['researcher'],
        llmProvider: 'openrouter',
        memory: { isolated: false },
        tools: ['web_search', 'web_fetch'],
      };
      expect(validateSpecialist(researcher)).toEqual({ ok: true });
    });

    it('parseSpecialists accepts wire format containing the Researcher stanza', () => {
      const wire = JSON.stringify({
        version: 1,
        generation: 0,
        specialists: [
          {
            name: 'Researcher',
            prompt:
              'You are a web-research specialist. When given a topic or question:\n' +
              '1. Search for relevant, current information using available search tools.\n' +
              '2. Fetch and read promising sources to gather details.\n' +
              '3. Synthesise findings into a concise, structured summary with:\n' +
              '   - A one-paragraph executive summary.\n' +
              '   - Key facts as a bulleted list.\n' +
              '   - Source URLs cited inline.\n' +
              'Stay factual; note when information is uncertain or conflicting.\n',
            triggers: ['researcher'],
            llmProvider: 'openrouter',
            memory: { isolated: false },
            tools: ['web_search', 'web_fetch'],
          },
        ],
      });
      const result = parseSpecialists(wire);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.specialists).toHaveLength(1);
        expect(result.specialists[0].name).toBe('Researcher');
        expect(result.specialists[0].memory?.isolated).toBe(false);
        expect(result.specialists[0].tools).toEqual(['web_search', 'web_fetch']);
        expect(result.specialists[0].triggers).toEqual(['researcher']);
      }
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL**

  ```bash
  npm test -- src/specialists/types.test.ts
  ```

  Expected: the two new tests under `Researcher baseline specialist` fail because `validateSpecialist` has not yet been called with this data (the object does not yet exist in any source — the test bodies reference a runtime value, so they will actually pass immediately). Re-read: these tests will *pass* as-is since `validateSpecialist` already handles all these field types. This step is therefore a green-baseline confirmation run, not a red step. **Expected: PASS (2 new tests green).** If they fail, the field types or keys have drifted — investigate before proceeding.

- [ ] **Step 3: Add the `Researcher` YAML stanza to `helm/kubeclaw/values.yaml`**

  Replace the current `specialists: []` line (line 439) with:

  ```yaml
  specialists:
    - name: Researcher
      prompt: |
        You are a web-research specialist. When given a topic or question:
        1. Search for relevant, current information using available search tools.
        2. Fetch and read promising sources to gather details.
        3. Synthesise findings into a concise, structured summary with:
           - A one-paragraph executive summary.
           - Key facts as a bulleted list.
           - Source URLs cited inline.
        Stay factual; note when information is uncertain or conflicting.
      triggers:
        - researcher
      llmProvider: openrouter
      memory:
        isolated: false
      tools:
        - web_search
        - web_fetch
  ```

- [ ] **Step 4: Verify Helm rendering**

  ```bash
  helm template helm/kubeclaw | grep -A50 'specialists-baseline'
  ```

  Expected output includes the `kubeclaw-specialists-baseline` ConfigMap with `"Researcher"` in the JSON array and `"isolated":false` in the memory object. If the output shows `"specialists":[]`, the YAML was not parsed correctly — check indentation.

- [ ] **Step 5: Run unit tests, expect PASS**

  ```bash
  npm test -- src/specialists/types.test.ts
  ```

  Expected: all tests pass, including the two new `Researcher baseline specialist` tests.

- [ ] **Step 6: Commit**

  ```bash
  git add helm/kubeclaw/values.yaml src/specialists/types.test.ts
  git commit -m "feat: add Researcher specialist to Helm baseline values

  Adds a Researcher entry to values.yaml under specialists:, rendering
  into the kubeclaw-specialists-baseline ConfigMap at deploy time.
  Adds unit tests asserting validateSpecialist and parseSpecialists
  both accept the full Researcher stanza.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 2: Integration — reconciler merges the Researcher baseline entry

Verify that `SpecialistReconciler.apply()` with a `baselineLoader` that returns the Researcher entry produces a rendered ConfigMap JSON containing `Researcher` with all fields intact, and that `parseSpecialists` of that JSON round-trips cleanly.

**Files:**
- Test: `src/specialists/reconciler.test.ts`

---

- [ ] **Step 1: Write failing test in `src/specialists/reconciler.test.ts`**

  Add a new `it` inside the existing `describe('SpecialistReconciler.apply', ...)` block, after the last existing test:

  ```typescript
  it('renders Researcher baseline entry with all fields via ConfigMap apply', async () => {
    const researcherBaseline = [
      {
        name: 'Researcher',
        prompt:
          'You are a web-research specialist. When given a topic or question:\n' +
          '1. Search for relevant, current information using available search tools.\n' +
          '2. Fetch and read promising sources to gather details.\n' +
          '3. Synthesise findings into a concise, structured summary with:\n' +
          '   - A one-paragraph executive summary.\n' +
          '   - Key facts as a bulleted list.\n' +
          '   - Source URLs cited inline.\n' +
          'Stay factual; note when information is uncertain or conflicting.\n',
        triggers: ['researcher'],
        llmProvider: 'openrouter',
        memory: { isolated: false },
        tools: ['web_search', 'web_fetch'],
      },
    ];

    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new SpecialistReconciler({
      baselineLoader: () => researcherBaseline,
      configMapApply: apply,
    });
    await r.apply();

    expect(apply).toHaveBeenCalledOnce();
    const rendered: string = apply.mock.calls[0][0];

    // Round-trip: parseSpecialists must accept the rendered JSON.
    const parseResult = parseSpecialists(rendered);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return; // type narrowing

    // The entry must survive the merge/render round-trip intact.
    const researcher = parseResult.specialists.find((s) => s.name === 'Researcher');
    expect(researcher, 'Researcher entry missing from rendered catalog').toBeDefined();
    expect(researcher!.triggers).toEqual(['researcher']);
    expect(researcher!.llmProvider).toBe('openrouter');
    expect(researcher!.memory?.isolated).toBe(false);
    expect(researcher!.tools).toEqual(['web_search', 'web_fetch']);
    expect(researcher!.prompt).toContain('web-research specialist');
  });
  ```

  Also add `parseSpecialists` to the existing import at the top of the file:

  ```typescript
  import {
    mergeCatalog,
    renderCatalog,
    SpecialistReconciler,
  } from './reconciler.js';
  import { parseSpecialists } from './types.js';
  import { _initTestDatabase, __resetDbForTest } from '../db.js';
  import { registerSpecialist } from '../skills/orchestrator/specialist-registry.js';
  ```

- [ ] **Step 2: Run test, expect FAIL**

  ```bash
  npm test -- src/specialists/reconciler.test.ts
  ```

  Expected: FAIL with `SyntaxError` or `Cannot find name 'parseSpecialists'` because `parseSpecialists` is not yet imported. (If the import was added in Step 1, the test will actually pass immediately since `SpecialistReconciler` + `renderCatalog` already handle all field types. **Treat a green result here as the expected baseline confirmation** — it means the existing reconciler already handles the Researcher stanza correctly.)

- [ ] **Step 3: Run test, expect PASS**

  ```bash
  npm test -- src/specialists/reconciler.test.ts
  ```

  Expected: all existing tests plus the new `renders Researcher baseline entry` test pass.

- [ ] **Step 4: Commit**

  ```bash
  git add src/specialists/reconciler.test.ts
  git commit -m "test: integration coverage for Researcher entry in reconciler

  Adds a SpecialistReconciler.apply test that feeds the Researcher
  baseline entry through the full merge+render cycle and asserts
  parseSpecialists round-trips cleanly with all fields (triggers,
  llmProvider, memory.isolated, tools) intact.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 3: E2E — `@researcher` dispatches via Helm baseline and returns a reply prefixed `[@Researcher]`

Extend `e2e/specialist-catalog.test.ts` with a test that does a `helmUpgrade` with the full Researcher stanza, sends `@researcher what is the boiling point of water?`, and asserts the SSE reply contains `[@Researcher]` and some reference to boiling / water / temperature.

**Files:**
- Test: `e2e/specialist-catalog.test.ts`

Note: the test uses the real live LLM (OpenRouter or the configured `LIVE_LLM_BASE_URL` provider). It is skipped when `shouldSkip` is true (no cluster or no provider), consistent with all other tests in this suite.

---

- [ ] **Step 1: Write the new test at the end of the `describe('global specialist catalog e2e', ...)` block in `e2e/specialist-catalog.test.ts`**

  Add immediately after Test 5's closing `},` and before the closing `});` of the describe block:

  ```typescript
  /**
   * Test 6: Helm baseline Researcher specialist dispatches on @researcher mention.
   *
   * Install kubeclaw with the full Researcher stanza from values.yaml.
   * Send '@researcher what is the boiling point of water?' and assert that:
   *   1. The SSE stream contains a reply prefixed with [@Researcher].
   *   2. The reply body references boiling, water, or temperature (loose match
   *      to tolerate small-model variation).
   *
   * memory.isolated is false — the Researcher shares the group session, which
   * is the intended production behaviour for iterative refinement.
   */
  it.skipIf(shouldSkip)(
    'Helm baseline Researcher specialist replies on @researcher mention',
    async () => {
      helmUpgrade([
        '--set-json',
        JSON.stringify({
          specialists: [
            {
              name: 'Researcher',
              prompt:
                'You are a web-research specialist. When given a topic or question:\n' +
                '1. Search for relevant, current information using available search tools.\n' +
                '2. Fetch and read promising sources to gather details.\n' +
                '3. Synthesise findings into a concise, structured summary with:\n' +
                '   - A one-paragraph executive summary.\n' +
                '   - Key facts as a bulleted list.\n' +
                '   - Source URLs cited inline.\n' +
                'Stay factual; note when information is uncertain or conflicting.\n',
              triggers: ['researcher'],
              llmProvider: 'openrouter',
              memory: { isolated: false },
              tools: ['web_search', 'web_fetch'],
            },
          ],
        }).replace(/^/, '').trim(),
      ]);

      // Bounce the orchestrator so it re-reconciles with the new baseline CM.
      kcCluster([
        'rollout', 'restart',
        'deployment/kubeclaw-orchestrator',
        '-n', NAMESPACE,
      ], { timeout: 30_000 });
      await waitForOrchestrator(120_000);

      await waitForChannelPod();
      await startPortForward();

      // Allow ConfigMap propagation into the channel pod volume mount.
      await sleep(60_000);

      const lines = await sendAndCollect(
        '@researcher what is the boiling point of water?',
        (ls) => ls.some((l) => l.includes('[@Researcher]')),
        90_000,
      );

      const reply = lines.find((l) => l.includes('[@Researcher]'));
      expect(
        reply,
        `no [@Researcher] reply in SSE lines: ${JSON.stringify(lines)}`,
      ).toBeDefined();
      expect(reply).toMatch(/\[@Researcher\]/);

      // Loose content check: the reply should mention something about boiling,
      // water, or temperature. Small models may phrase this many ways.
      const replyLower = reply!.toLowerCase();
      const mentionsBoiling =
        replyLower.includes('boil') ||
        replyLower.includes('100') ||
        replyLower.includes('212') ||
        replyLower.includes('water') ||
        replyLower.includes('celsius') ||
        replyLower.includes('fahrenheit') ||
        replyLower.includes('temperature');
      expect(
        mentionsBoiling,
        `Expected reply to reference boiling point context, got: ${reply}`,
      ).toBe(true);
    },
    // 60s propagation + 120s orchestrator restart + 90s LLM + margin
    330_000,
  );
  ```

  Note on the `--set-json` value: `helmUpgrade` passes extra args directly to `helm upgrade`. The cleanest way to pass the Researcher JSON is as a single `--set-json` argument with the `specialists` array. Use the literal string form below (avoids shell escaping in `spawnSync` since args are passed as an array, not a shell string):

  Replace the `helmUpgrade([...])` call above with:

  ```typescript
  helmUpgrade([
    '--set-json',
    'specialists=[{"name":"Researcher","prompt":"You are a web-research specialist. When given a topic or question:\\n1. Search for relevant, current information using available search tools.\\n2. Fetch and read promising sources to gather details.\\n3. Synthesise findings into a concise, structured summary with:\\n   - A one-paragraph executive summary.\\n   - Key facts as a bulleted list.\\n   - Source URLs cited inline.\\nStay factual; note when information is uncertain or conflicting.\\n","triggers":["researcher"],"llmProvider":"openrouter","memory":{"isolated":false},"tools":["web_search","web_fetch"]}]',
  ]);
  ```

- [ ] **Step 2: Run the e2e file in dry-run (lint-only) mode to check TypeScript**

  ```bash
  npm run build 2>&1 | grep -E 'specialist-catalog|error TS' | head -20
  ```

  Expected: no TypeScript errors for `e2e/specialist-catalog.test.ts`. If `kcCluster` is flagged as possibly undefined in the new test, check its definition — it is defined at module scope in the file and available to all tests.

- [ ] **Step 3: Run the e2e test (skipped unless cluster + provider are available)**

  ```bash
  npm test -- e2e/specialist-catalog.test.ts
  ```

  Expected when cluster and provider are absent: all 6 tests show `skipped` (the `shouldSkip` guard). Expected when cluster and provider are present: Test 6 passes within the 330 s timeout. If it fails with `no [@Researcher] reply`, check:
  - The `kubeclaw-specialists` ConfigMap contains the Researcher entry (`kubectl get cm kubeclaw-specialists -n kubeclaw-sc-test -o jsonpath='{.data.specialists\.json}'`).
  - The orchestrator pod restarted and reconciled after the `helmUpgrade` (`kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw-sc-test | grep 'specialists ConfigMap applied'`).
  - The `sleep(60_000)` ConfigMap propagation window was sufficient.

- [ ] **Step 4: Commit**

  ```bash
  git add e2e/specialist-catalog.test.ts
  git commit -m "test(e2e): Researcher specialist dispatches via Helm baseline

  Adds e2e test 6 to specialist-catalog.test.ts: helmUpgrade with the
  full Researcher stanza, orchestrator bounce, ConfigMap propagation
  wait, then sendAndCollect('@researcher what is the boiling point of
  water?') asserting [@Researcher] reply with boiling-point content.
  Skipped when cluster or LLM provider is unavailable (consistent with
  existing suite skip guard).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Test coverage summary

| Level       | File                                     | What is tested                                                                                      |
| ----------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Unit        | `src/specialists/types.test.ts`          | `validateSpecialist` and `parseSpecialists` accept the full Researcher object (all field types)     |
| Integration | `src/specialists/reconciler.test.ts`     | `SpecialistReconciler.apply` with Researcher baseline produces parseable JSON with all fields intact |
| E2E         | `e2e/specialist-catalog.test.ts`         | Full Helm-baseline → ConfigMap propagation → SSE `[@Researcher]` reply round-trip                   |

## Notes for the implementer

- **`memory.isolated: false` is deliberate.** With `false`, successive `@researcher` turns accumulate in the group-folder session (`<group>/session_key`), enabling iterative refinement. See `docs/SPECIALISTS.md` "Research" example and `src/specialists/types.ts` line 6.
- **`tools: ['web_search', 'web_fetch']` are declared strings.** The channel pod resolves actual tool bindings at call time; the YAML stanza is just the allow-list. If the deployed channel image does not have these tools wired, the specialist will still reply — it will simply note that the tools are unavailable.
- **Helm rendering check** (`helm template | grep -A50 specialists-baseline`) is a fast sanity gate that catches indentation errors in `values.yaml` before any cluster interaction.
- **`parseSpecialists` import** must be added to `reconciler.test.ts` in Task 2 Step 1. It is exported from `src/specialists/types.ts` (line 89).
- **`kcCluster` in the e2e test** — already defined at module scope in `e2e/specialist-catalog.test.ts` (line 151); no import needed.
