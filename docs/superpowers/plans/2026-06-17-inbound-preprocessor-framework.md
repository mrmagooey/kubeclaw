# Inbound-Preprocessor Framework + Voice Transcription (SP3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the single hardcoded RAG `augmentPrompt` seam in the channel agent loop into an ordered, non-fatal inbound-preprocessor chain (content transforms before prompt augmenters), and add voice transcription as a marker-driven content transform backed by a new `transcription` capability kind discovered exactly like `rag`.

**Architecture:** A new channel-side `src/runtime/preprocessors/` module defines `InboundPreprocessor` (effect `'transform' | 'augment'`) and `runPreprocessorChain`, which runs all transforms first (each may rewrite the canonical user content) then all augmenters (which only prefix the LLM-facing prompt). RAG becomes the first augmenter (a thin adapter over the unchanged `augmentPrompt`); transcription becomes the first transform (reads the audio file from the group PVC by the `[VoiceAttachment: …]` marker path, POSTs multipart to a `transcription` capability, substitutes the transcript). The `transcription` kind mirrors `rag`: config-on-spec, `getTranscriptionEntry` discovery with no secrets, normalize-on-read, the generic builder, and a one-per-channel conflict guard.

**Tech Stack:** TypeScript ESM (.js suffixes), Vitest, the `yaml` package, Kubernetes/Helm.

## Global Constraints

- **Chain contract (D2/D3):** `InboundPreprocessor.apply(input) → Promise<{ prompt: string; persistedContent?: string }>`. `runPreprocessorChain(preprocessors, groupFolder, prompt) → Promise<{ prompt: string; persistedContent: string }>`. Transforms run **before** augmenters (partition by `effect`, preserve registration order within each phase). Only `transform` preprocessors may set `persistedContent`; an augmenter's `persistedContent` is ignored (and logged at `warn` if set). The chain's returned `persistedContent` is the post-transform / **pre-augment** canonical user text (defaults to the original prompt when no transform fired).
- **RAG is byte-preserving (regression):** RAG becomes an `augment` preprocessor wrapping the **unchanged** `augmentPrompt` from `src/rag/provider.ts`. With no voice marker present, the chain output MUST equal today's behaviour exactly: `prompt === augmentPrompt(original)`, `persistedContent === original`. A regression test pins this.
- **Transcription is a transform (D2):** sets **both** `prompt` and `persistedContent` to the transcript-substituted text, so the transcript (not the marker) is persisted, indexed, and what RAG retrieves against.
- **Non-fatal per preprocessor (D4):** each `apply` is wrapped so a throw/rejection is caught, logged at `warn`, and treated as a no-op for that stage (returns the running prompt unchanged). The chain NEVER throws.
- **Transcription is channel-side, marker-driven (D1):** read the audio file from `path.join(GROUPS_DIR, groupFolder, rawPath)`. Do **NOT** use the orchestrator `runPreprocessingJob` K8s-job path. Do **NOT** add any audio/binary field to `ContainerInput`. The marker + on-disk file is the only carrier.
- **`transcription` is a new capability kind parallel to `rag` (D5/D6/D7):** config-on-spec (`TranscriptionProviderConfig`), `getTranscriptionEntry(channel)` discovery, **no secrets in the discovery entry**, generic builder (no per-impl builder), one-per-channel conflict guard, normalize-on-read (`normalizeTranscriptionSpec`). Audio transport is `multipart/form-data` POST; provider config carries `transcribePath` (default `/v1/audio/transcriptions`), optional `model`, `responseField` (default `text`), `timeoutMs` (default 60000). Default port 9000.
- **Every new field is optional.** New `transcription` specs without a `provider` block must still resolve via normalization. Existing `mcp`/`http`/`rag` specs and rendered YAML are unchanged.
- **ESM `.js` import suffix** on every relative import. **Colocated `*.test.ts`** next to the unit under test (e2e tests live in `e2e/`).
- **The codebase must compile and test green after every task's commit.** Order tasks so no commit leaves a broken switch/type.
- **Run a single test file with:**
  `cd /home/peter/projects/kubeclaw/.worktrees/cap-overhaul && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null && npx vitest run <file>`
- **Run the full unit/integration suite (regression) with:**
  `cd /home/peter/projects/kubeclaw/.worktrees/cap-overhaul && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null && npx vitest run --exclude 'e2e/**'`
- **Type-check with:**
  `cd /home/peter/projects/kubeclaw/.worktrees/cap-overhaul && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null && npx tsc --noEmit`
- **Branch:** all work happens on `feat/capability-base-generalization` in the worktree `/home/peter/projects/kubeclaw/.worktrees/cap-overhaul` (already contains SP1+SP2). Do NOT work on `main`.
- **Commit after each task** with the exact message given. Do not push or open a PR unless explicitly asked.

---

### Task 1: `InboundPreprocessor` interface + `runPreprocessorChain`

Create the framework with no consumers yet: the effect/in/out types and the chain runner that partitions transforms-before-augmenters, propagates `persistedContent`, ignores augmenter `persistedContent`, and is non-fatal. Pure module, fully unit-tested.

**Files:**
- Create: `src/runtime/preprocessors/types.ts` — `PreprocessorEffect`, `PreprocessorInput`, `PreprocessorResult`, `InboundPreprocessor`.
- Create: `src/runtime/preprocessors/chain.ts` — `ChainOutput`, `runPreprocessorChain`.
- Test: `src/runtime/preprocessors/chain.test.ts` (new).

**Interfaces:**
- **Consumes:** `logger` from `../../logger.js`.
- **Produces:**
  - `type PreprocessorEffect = 'transform' | 'augment';`
  - `interface PreprocessorInput { groupFolder: string; prompt: string; }`
  - `interface PreprocessorResult { prompt: string; persistedContent?: string; }`
  - `interface InboundPreprocessor { readonly name: string; readonly effect: PreprocessorEffect; apply(input: PreprocessorInput): Promise<PreprocessorResult>; }`
  - `interface ChainOutput { prompt: string; persistedContent: string; }`
  - `function runPreprocessorChain(preprocessors: InboundPreprocessor[], groupFolder: string, prompt: string): Promise<ChainOutput>`

**Steps:**

1. [ ] Write the failing test. Create `src/runtime/preprocessors/chain.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runPreprocessorChain } from './chain.js';
import type { InboundPreprocessor } from './types.js';

const transform = (
  name: string,
  fn: (p: string) => string,
): InboundPreprocessor => ({
  name,
  effect: 'transform',
  async apply({ prompt }) {
    const out = fn(prompt);
    return { prompt: out, persistedContent: out };
  },
});

const augment = (
  name: string,
  fn: (p: string) => string,
): InboundPreprocessor => ({
  name,
  effect: 'augment',
  async apply({ prompt }) {
    return { prompt: fn(prompt) };
  },
});

describe('runPreprocessorChain', () => {
  it('is an identity for the empty chain', async () => {
    const out = await runPreprocessorChain([], 'g', 'hello');
    expect(out.prompt).toBe('hello');
    expect(out.persistedContent).toBe('hello');
  });

  it('runs transforms before augmenters regardless of registration order', async () => {
    const calls: string[] = [];
    const a = augment('aug', (p) => {
      calls.push('aug');
      return `AUG(${p})`;
    });
    const t = transform('xform', (p) => {
      calls.push('xform');
      return `T(${p})`;
    });
    const out = await runPreprocessorChain([a, t], 'g', 'x');
    expect(calls).toEqual(['xform', 'aug']);
    expect(out.prompt).toBe('AUG(T(x))');
  });

  it('persistedContent is post-transform, pre-augment', async () => {
    const t = transform('xform', (p) => `T(${p})`);
    const a = augment('aug', (p) => `AUG(${p})`);
    const out = await runPreprocessorChain([t, a], 'g', 'x');
    expect(out.prompt).toBe('AUG(T(x))');
    expect(out.persistedContent).toBe('T(x)');
  });

  it('augmenters retrieve against the transformed text', async () => {
    let seenByAugmenter = '';
    const t = transform('xform', () => 'TRANSCRIPT');
    const a: InboundPreprocessor = {
      name: 'aug',
      effect: 'augment',
      async apply({ prompt }) {
        seenByAugmenter = prompt;
        return { prompt: `CTX\n${prompt}` };
      },
    };
    await runPreprocessorChain([t, a], 'g', '[VoiceAttachment: attachments/raw/a.ogg]');
    expect(seenByAugmenter).toBe('TRANSCRIPT');
  });

  it('chains multiple transforms, each feeding the next', async () => {
    const t1 = transform('t1', (p) => `${p}-1`);
    const t2 = transform('t2', (p) => `${p}-2`);
    const out = await runPreprocessorChain([t1, t2], 'g', 'base');
    expect(out.prompt).toBe('base-1-2');
    expect(out.persistedContent).toBe('base-1-2');
  });

  it('ignores persistedContent set by an augmenter', async () => {
    const a: InboundPreprocessor = {
      name: 'bad-aug',
      effect: 'augment',
      async apply({ prompt }) {
        return { prompt: `AUG(${prompt})`, persistedContent: 'SHOULD_BE_IGNORED' };
      },
    };
    const out = await runPreprocessorChain([a], 'g', 'x');
    expect(out.prompt).toBe('AUG(x)');
    expect(out.persistedContent).toBe('x');
  });

  it('is non-fatal: a throwing transform is skipped and the chain continues', async () => {
    const boom: InboundPreprocessor = {
      name: 'boom',
      effect: 'transform',
      async apply() {
        throw new Error('kaboom');
      },
    };
    const a = augment('aug', (p) => `AUG(${p})`);
    const out = await runPreprocessorChain([boom, a], 'g', 'x');
    expect(out.prompt).toBe('AUG(x)');
    expect(out.persistedContent).toBe('x');
  });

  it('is non-fatal: a throwing augmenter leaves the running prompt unchanged', async () => {
    const t = transform('xform', (p) => `T(${p})`);
    const boom: InboundPreprocessor = {
      name: 'boom',
      effect: 'augment',
      async apply() {
        throw new Error('kaboom');
      },
    };
    const out = await runPreprocessorChain([t, boom], 'g', 'x');
    expect(out.prompt).toBe('T(x)');
    expect(out.persistedContent).toBe('T(x)');
  });
});
```

2. [ ] Run it, expect FAIL (module does not exist yet):
   `cd /home/peter/projects/kubeclaw/.worktrees/cap-overhaul && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null && npx vitest run src/runtime/preprocessors/chain.test.ts`
   Expected: `Cannot find module './chain.js'`.

3. [ ] Implement. Create `src/runtime/preprocessors/types.ts`:

```ts
/**
 * Inbound-preprocessor framework types (channel-side).
 *
 * An inbound preprocessor runs on a user turn immediately before the LLM call.
 * Two effect types:
 *   - 'transform' rewrites the canonical user content (e.g. voice → text). It
 *     sets BOTH `prompt` (handed to the next stage / LLM) and `persistedContent`
 *     (the new text to store + index). Transforms run first.
 *   - 'augment'  only prefixes the LLM-facing prompt (e.g. RAG <retrieved_context>).
 *     It sets `prompt` only; its `persistedContent` is ignored by the chain.
 */

export type PreprocessorEffect = 'transform' | 'augment';

export interface PreprocessorInput {
  groupFolder: string;
  /** Current prompt (already transformed by earlier transforms in the chain). */
  prompt: string;
}

export interface PreprocessorResult {
  /** Prompt handed to the next stage / the LLM. */
  prompt: string;
  /**
   * Set ONLY by `transform` preprocessors: the new canonical user content to
   * persist + index (replaces the marker text). Omitted by augmenters.
   */
  persistedContent?: string;
}

export interface InboundPreprocessor {
  readonly name: string;
  readonly effect: PreprocessorEffect;
  /** MUST be non-throwing in practice — but the chain also guards every call. */
  apply(input: PreprocessorInput): Promise<PreprocessorResult>;
}
```

Create `src/runtime/preprocessors/chain.ts`:

```ts
/**
 * Inbound-preprocessor chain runner.
 *
 * Order (fixed): all `transform` preprocessors first (producing the canonical
 * user text), then all `augment` preprocessors (against that canonical text).
 * Within a phase, registration order is preserved.
 *
 * - Transforms may set `persistedContent`; the last transform's text becomes
 *   both the running prompt and the canonical `persistedContent`.
 * - Augmenters set `prompt` only; any `persistedContent` they return is ignored
 *   (logged at warn) because only transforms define canonical content.
 * - Every `apply` is wrapped: a throw/rejection is caught, logged at warn, and
 *   treated as a no-op for that stage. The chain never throws.
 */
import { logger } from '../../logger.js';
import type { InboundPreprocessor } from './types.js';

export interface ChainOutput {
  /** Prompt for the LLM turn (post-transform, post-augment). */
  prompt: string;
  /** Canonical user content for persistence + indexing (post-transform, PRE-augment). */
  persistedContent: string;
}

export async function runPreprocessorChain(
  preprocessors: InboundPreprocessor[],
  groupFolder: string,
  prompt: string,
): Promise<ChainOutput> {
  const transforms = preprocessors.filter((p) => p.effect === 'transform');
  const augmenters = preprocessors.filter((p) => p.effect === 'augment');

  let running = prompt;
  let persistedContent = prompt;

  for (const pp of transforms) {
    try {
      const result = await pp.apply({ groupFolder, prompt: running });
      running = result.prompt;
      if (result.persistedContent !== undefined) {
        persistedContent = result.persistedContent;
      }
    } catch (err) {
      logger.warn({ err, preprocessor: pp.name, groupFolder }, 'transform preprocessor failed; skipping');
    }
  }

  for (const pp of augmenters) {
    try {
      const result = await pp.apply({ groupFolder, prompt: running });
      if (result.persistedContent !== undefined) {
        logger.warn(
          { preprocessor: pp.name },
          'augmenter set persistedContent; ignoring (only transforms define canonical content)',
        );
      }
      running = result.prompt;
    } catch (err) {
      logger.warn({ err, preprocessor: pp.name, groupFolder }, 'augment preprocessor failed; skipping');
    }
  }

  return { prompt: running, persistedContent };
}
```

4. [ ] Run, expect PASS:
   `... npx vitest run src/runtime/preprocessors/chain.test.ts`

5. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**'` then `... npx tsc --noEmit`

6. [ ] Commit:
   `git add -A && git commit -m "feat(preprocessors): InboundPreprocessor interface + runPreprocessorChain (SP3 task 1)"`

---

### Task 2: RAG-as-augmenter adapter

A thin `augment` preprocessor over the unchanged `augmentPrompt`. Never sets `persistedContent`; non-fatal on throw.

**Files:**
- Create: `src/runtime/preprocessors/rag-preprocessor.ts`.
- Test: `src/runtime/preprocessors/rag-preprocessor.test.ts` (new).

**Interfaces:**
- **Consumes (Task 1):** `InboundPreprocessor`, `PreprocessorInput`, `PreprocessorResult` from `./types.js`; `runPreprocessorChain` from `./chain.js` (regression test only). `augmentPrompt(groupFolder, prompt): Promise<string>` from `../../rag/provider.js` (existing, unchanged signature — see `src/rag/provider.ts:239-245`).
- **Produces:** `class RagPreprocessor implements InboundPreprocessor` with `name = 'rag'`, `effect = 'augment'`.

**Steps:**

1. [ ] Write the failing test. Create `src/runtime/preprocessors/rag-preprocessor.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const augmentPrompt = vi.hoisted(() => vi.fn());
vi.mock('../../rag/provider.js', () => ({ augmentPrompt }));
vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { RagPreprocessor } from './rag-preprocessor.js';
import { runPreprocessorChain } from './chain.js';

describe('RagPreprocessor', () => {
  it('is an augment effect named rag', () => {
    const p = new RagPreprocessor();
    expect(p.name).toBe('rag');
    expect(p.effect).toBe('augment');
  });

  it('delegates to augmentPrompt and never sets persistedContent', async () => {
    augmentPrompt.mockResolvedValueOnce('<retrieved_context>\nMEM\n</retrieved_context>\n\nhello');
    const result = await new RagPreprocessor().apply({ groupFolder: 'g', prompt: 'hello' });
    expect(augmentPrompt).toHaveBeenCalledWith('g', 'hello');
    expect(result.prompt).toBe('<retrieved_context>\nMEM\n</retrieved_context>\n\nhello');
    expect(result.persistedContent).toBeUndefined();
  });

  it('is non-fatal: returns the input prompt when augmentPrompt throws', async () => {
    augmentPrompt.mockRejectedValueOnce(new Error('qdrant down'));
    const result = await new RagPreprocessor().apply({ groupFolder: 'g', prompt: 'hello' });
    expect(result.prompt).toBe('hello');
    expect(result.persistedContent).toBeUndefined();
  });

  // Regression: a chain with only RAG reproduces the SP2 seam byte-for-byte.
  it('chain with only RagPreprocessor: prompt=augmented, persistedContent=original', async () => {
    augmentPrompt.mockResolvedValueOnce('<retrieved_context>\nM\n</retrieved_context>\n\nhi');
    const out = await runPreprocessorChain([new RagPreprocessor()], 'g', 'hi');
    expect(out.prompt).toBe('<retrieved_context>\nM\n</retrieved_context>\n\nhi');
    expect(out.persistedContent).toBe('hi');
  });
});
```

2. [ ] Run it, expect FAIL:
   `... npx vitest run src/runtime/preprocessors/rag-preprocessor.test.ts`
   Expected: `Cannot find module './rag-preprocessor.js'`.

3. [ ] Implement. Create `src/runtime/preprocessors/rag-preprocessor.ts`:

```ts
/**
 * RAG as the first prompt augmenter.
 *
 * A thin adapter over the unchanged augmentPrompt (src/rag/provider.ts). It
 * prefixes <retrieved_context> onto the LLM-facing prompt and NEVER sets
 * persistedContent — so stored/indexed history stays the canonical user text,
 * preserving the SP2 contract byte-for-byte. Non-fatal: any failure returns the
 * input prompt unchanged.
 */
import { logger } from '../../logger.js';
import { augmentPrompt } from '../../rag/provider.js';
import type {
  InboundPreprocessor,
  PreprocessorInput,
  PreprocessorResult,
} from './types.js';

export class RagPreprocessor implements InboundPreprocessor {
  readonly name = 'rag';
  readonly effect = 'augment' as const;

  async apply({ groupFolder, prompt }: PreprocessorInput): Promise<PreprocessorResult> {
    try {
      return { prompt: await augmentPrompt(groupFolder, prompt) };
    } catch (err) {
      logger.warn({ err, groupFolder }, 'RAG augment failed; continuing without context');
      return { prompt };
    }
  }
}
```

4. [ ] Run, expect PASS:
   `... npx vitest run src/runtime/preprocessors/rag-preprocessor.test.ts`

5. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**'` then `... npx tsc --noEmit`

6. [ ] Commit:
   `git add -A && git commit -m "feat(preprocessors): RAG augmenter adapter over augmentPrompt (SP3 task 2)"`

---

### Task 3: Transcription capability types + `normalizeTranscriptionSpec` + discovery entry

Add the `transcription` kind to the `CapabilitySpec` union, the `TranscriptionProviderConfig`, the discovery-entry member (no secrets — provider config only), and a normalize-on-read reader mirroring `rag-config.ts`. Keeps the project compiling: the new kind is added to the union, so every `switch (spec.kind)` that is exhaustive must gain a `transcription` arm in this task. The two builder/registry switches are covered in Task 7; until then the orchestrator-side `defaultPort`/`buildYaml` switches will fail to compile. To keep this commit green, this task ALSO adds minimal `transcription` arms to those two switches (a `defaultPort` case returning the default port, and a `buildYaml` case calling the generic renderer). Task 7 then adds the discovery-entry emission, conflict guard, and the dedicated builder test.

**Files:**
- Modify: `src/capabilities/types.ts` — add `TranscriptionProviderConfig`, `TranscriptionCapabilitySpec`; add `TranscriptionCapabilitySpec` to the `CapabilitySpec` union (line 167–170); add the `transcription` member to `CapabilityDiscoveryEntry` (after the `http` member at line 222–229).
- Create: `src/capabilities/transcription-config.ts` — `DEFAULT_TRANSCRIPTION_CONFIG` + `normalizeTranscriptionSpec()`.
- Modify (compile-keeping minimal arms): `src/capabilities/registry.ts` (`defaultPort` switch lines 34–43; `specToDiscoveryEntry` switch lines 54–81); `src/capabilities/builders/index.ts` (`buildYaml` switch lines 31–45).
- Test: `src/capabilities/transcription-config.test.ts` (new).

**Interfaces:**
- **Produces:**
  - `interface TranscriptionProviderConfig { transcribePath?: string; model?: string; responseField?: string; timeoutMs?: number; }`
  - `interface TranscriptionCapabilitySpec extends CapabilityBase { kind: 'transcription'; provider?: TranscriptionProviderConfig; }`
  - discovery entry member: `{ name: string; kind: 'transcription'; endpoint: string; kindMetadata: { provider: TranscriptionProviderConfig }; state?: ...; error?: ...; }`
  - `interface NormalizedTranscriptionSpec extends TranscriptionCapabilitySpec { provider: TranscriptionProviderConfig }`
  - `const DEFAULT_TRANSCRIPTION_CONFIG: { transcribePath: string; responseField: string; timeoutMs: number }`
  - `function normalizeTranscriptionSpec(spec: TranscriptionCapabilitySpec): NormalizedTranscriptionSpec`

**Steps:**

1. [ ] Write the failing test. Create `src/capabilities/transcription-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  normalizeTranscriptionSpec,
  DEFAULT_TRANSCRIPTION_CONFIG,
} from './transcription-config.js';
import type { TranscriptionCapabilitySpec } from './types.js';

describe('normalizeTranscriptionSpec', () => {
  it('fills provider defaults when provider is absent', () => {
    const out = normalizeTranscriptionSpec({
      kind: 'transcription',
      name: 'whisper',
      image: 'onerahmet/openai-whisper-asr-webservice:latest',
    } as TranscriptionCapabilitySpec);
    expect(out.provider.transcribePath).toBe(DEFAULT_TRANSCRIPTION_CONFIG.transcribePath);
    expect(out.provider.responseField).toBe(DEFAULT_TRANSCRIPTION_CONFIG.responseField);
    expect(out.provider.timeoutMs).toBe(DEFAULT_TRANSCRIPTION_CONFIG.timeoutMs);
    expect(out.provider.model).toBeUndefined();
  });

  it('fills only the missing fields on a partial provider', () => {
    const out = normalizeTranscriptionSpec({
      kind: 'transcription',
      name: 'w',
      image: 'img',
      provider: { transcribePath: '/asr', model: 'base.en' },
    } as TranscriptionCapabilitySpec);
    expect(out.provider.transcribePath).toBe('/asr');
    expect(out.provider.model).toBe('base.en');
    expect(out.provider.responseField).toBe('text');
    expect(out.provider.timeoutMs).toBe(60000);
  });

  it('preserves an explicit responseField and timeoutMs', () => {
    const out = normalizeTranscriptionSpec({
      kind: 'transcription',
      name: 'w',
      image: 'img',
      provider: { responseField: 'transcription', timeoutMs: 120000 },
    } as TranscriptionCapabilitySpec);
    expect(out.provider.responseField).toBe('transcription');
    expect(out.provider.timeoutMs).toBe(120000);
  });
});
```

2. [ ] Run it, expect FAIL:
   `... npx vitest run src/capabilities/transcription-config.test.ts`
   Expected: `Cannot find module './transcription-config.js'`.

3. [ ] Implement.

   In `src/capabilities/types.ts`, add after the `RagCapabilitySpec` block (after line 161, before `HttpCapabilitySpec`):

```ts
export interface TranscriptionProviderConfig {
  /** Multipart upload endpoint path. Default '/v1/audio/transcriptions'. */
  transcribePath?: string;
  /** Model name; sent as a multipart field when set. */
  model?: string;
  /** JSON field holding the transcript in the response. Default 'text'. */
  responseField?: string;
  /** Request timeout in ms. Default 60000 (Whisper-class can be slow). */
  timeoutMs?: number;
}

export interface TranscriptionCapabilitySpec extends CapabilityBase {
  kind: 'transcription';
  /** Optional; defaults filled by normalizeTranscriptionSpec() on read. */
  provider?: TranscriptionProviderConfig;
}
```

   Add `TranscriptionCapabilitySpec` to the union (replace lines 167–170):

```ts
export type CapabilitySpec =
  | McpCapabilitySpec
  | RagCapabilitySpec
  | TranscriptionCapabilitySpec
  | HttpCapabilitySpec;
```

   Add the discovery-entry member to `CapabilityDiscoveryEntry` (insert after the `http` member that ends at line 229, before `| GroupMcpEntry;`):

```ts
  | {
      name: string;
      kind: 'transcription';
      endpoint: string;
      kindMetadata: { provider: TranscriptionProviderConfig };
      state?: 'ready' | 'warming' | 'failed';
      error?: string;
    }
```

   Create `src/capabilities/transcription-config.ts`:

```ts
/**
 * Transcription provider-config defaults and normalize-on-read.
 *
 * Mirrors rag-config.ts. New `transcription` specs may omit `provider`;
 * normalizeTranscriptionSpec() fills the defaults on read so the consuming
 * client always sees a complete config. There are no legacy transcription rows,
 * so back-compat is vacuous — but the read path stays uniform with RAG.
 */
import type {
  TranscriptionCapabilitySpec,
  TranscriptionProviderConfig,
} from './types.js';

export const DEFAULT_TRANSCRIPTION_CONFIG = {
  transcribePath: '/v1/audio/transcriptions',
  responseField: 'text',
  timeoutMs: 60_000,
} as const;

/** Spec guaranteed to carry a resolved provider config. */
export interface NormalizedTranscriptionSpec extends TranscriptionCapabilitySpec {
  provider: TranscriptionProviderConfig;
}

export function normalizeTranscriptionSpec(
  spec: TranscriptionCapabilitySpec,
): NormalizedTranscriptionSpec {
  const p = spec.provider ?? {};
  return {
    ...spec,
    provider: {
      transcribePath: p.transcribePath ?? DEFAULT_TRANSCRIPTION_CONFIG.transcribePath,
      ...(p.model !== undefined ? { model: p.model } : {}),
      responseField: p.responseField ?? DEFAULT_TRANSCRIPTION_CONFIG.responseField,
      timeoutMs: p.timeoutMs ?? DEFAULT_TRANSCRIPTION_CONFIG.timeoutMs,
    },
  };
}
```

   In `src/capabilities/registry.ts`, add the port const (after line 32):

```ts
const TRANSCRIPTION_DEFAULT_PORT = 9000;
```

   Add a `transcription` arm to `defaultPort` (inside the switch at lines 34–43, after the `rag` case):

```ts
    case 'transcription':
      return spec.port ?? TRANSCRIPTION_DEFAULT_PORT;
```

   Add a minimal `transcription` arm to `specToDiscoveryEntry` (inside the switch, after the `rag` case ending line 73). Import `normalizeTranscriptionSpec` at the top of `registry.ts` alongside the existing `normalizeRagSpec` import (line 16):

```ts
import { normalizeTranscriptionSpec } from './transcription-config.js';
```

```ts
    case 'transcription': {
      const normalized = normalizeTranscriptionSpec(spec);
      return {
        name: spec.name,
        kind: 'transcription',
        endpoint,
        kindMetadata: { provider: normalized.provider },
      };
    }
```

   In `src/capabilities/builders/index.ts`, add a minimal generic `transcription` arm to `buildYaml` (inside the switch at lines 32–44, after the `rag` case). Add a default-port const and a small inline builder. First widen the type import (line 2):

```ts
import type {
  CapabilitySpec,
  RagCapabilitySpec,
  TranscriptionCapabilitySpec,
} from '../types.js';
```

   Add after the RAG consts (after line 9):

```ts
const TRANSCRIPTION_DEFAULT_PORT = 9000;
const TRANSCRIPTION_DEFAULT_HEALTH_PATH = '/health';
```

   Add the builder function (after `buildRagYaml`, before `export function buildYaml`):

```ts
function buildTranscriptionYaml(spec: TranscriptionCapabilitySpec): string {
  return renderDeploymentAndService({
    name: deploymentName(spec.name),
    namespace: KUBECLAW_NAMESPACE,
    component: 'capability-transcription',
    image: spec.image,
    port: spec.port ?? TRANSCRIPTION_DEFAULT_PORT,
    env: spec.env,
    envFromSecrets: spec.envFromSecrets,
    command: spec.command,
    args: spec.args,
    resources: spec.resources,
    healthPath: spec.healthPath ?? TRANSCRIPTION_DEFAULT_HEALTH_PATH,
    storage: spec.storage,
    probe: spec.probe,
    scheduling: spec.scheduling,
    podSecurity: spec.podSecurity,
  });
}
```

   Add the switch arm (after `case 'rag': return buildRagYaml(spec);`):

```ts
    case 'transcription':
      return buildTranscriptionYaml(spec);
```

4. [ ] Run, expect PASS:
   `... npx vitest run src/capabilities/transcription-config.test.ts`

5. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**'` then `... npx tsc --noEmit`
   Both the `defaultPort` and `buildYaml` exhaustive switches now have a `transcription` arm, so `tsc` is green. The existing `registry.test.ts`/`rag` tests are unaffected.

6. [ ] Commit:
   `git add -A && git commit -m "feat(transcription): capability kind + provider config + normalize-on-read + discovery entry (SP3 task 3)"`

---

### Task 4: Transcription client (config-driven multipart POST)

A `src/transcription/client.ts` parallel to the RAG provider's config-driven style: constructed from the discovery entry's `kindMetadata.provider` and the endpoint — no `process.env` reads. Reads an audio file by absolute path, POSTs `multipart/form-data` (global `FormData`/`Blob`/`fetch`, already used elsewhere in the repo), parses `responseField` from the JSON response, returns the transcript string.

**Files:**
- Create: `src/transcription/client.ts`.
- Test: `src/transcription/client.test.ts` (new).

**Interfaces:**
- **Consumes (Task 3):** `TranscriptionProviderConfig` from `../capabilities/types.js`; `DEFAULT_TRANSCRIPTION_CONFIG` from `../capabilities/transcription-config.js`. `logger` from `../logger.js`. Node `fs/promises.readFile`, `node:path.basename`.
- **Produces:**
  - `interface TranscriptionClientOpts { endpoint: string; provider: TranscriptionProviderConfig; }`
  - `class TranscriptionClient { constructor(opts: TranscriptionClientOpts); transcribeFile(absPath: string): Promise<string>; }`

**Steps:**

1. [ ] Write the failing test. Create `src/transcription/client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readFile = vi.hoisted(() => vi.fn());
vi.mock('fs/promises', () => ({ readFile }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TranscriptionClient } from './client.js';

beforeEach(() => {
  readFile.mockReset();
  vi.unstubAllGlobals();
});

const provider = {
  transcribePath: '/v1/audio/transcriptions',
  responseField: 'text',
  timeoutMs: 60000,
};

describe('TranscriptionClient', () => {
  it('POSTs multipart to endpoint+transcribePath and returns the responseField', async () => {
    readFile.mockResolvedValueOnce(Buffer.from('FAKEAUDIO'));
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'hello world' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new TranscriptionClient({ endpoint: 'http://cap:9000', provider });
    const out = await client.transcribeFile('/groups/g/attachments/raw/a.ogg');

    expect(out).toBe('hello world');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://cap:9000/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).has('file')).toBe(true);
  });

  it('sends the model multipart field when provider.model is set', async () => {
    readFile.mockResolvedValueOnce(Buffer.from('A'));
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 't' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new TranscriptionClient({
      endpoint: 'http://cap:9000/',
      provider: { ...provider, model: 'base.en' },
    });
    await client.transcribeFile('/x/a.ogg');

    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get('model')).toBe('base.en');
    // trailing slash on endpoint is normalized (no double slash)
    expect(fetchMock.mock.calls[0][0]).toBe('http://cap:9000/v1/audio/transcriptions');
  });

  it('reads a custom responseField', async () => {
    readFile.mockResolvedValueOnce(Buffer.from('A'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transcription: 'custom field value' }),
    }));
    const client = new TranscriptionClient({
      endpoint: 'http://cap:9000',
      provider: { ...provider, responseField: 'transcription' },
    });
    expect(await client.transcribeFile('/x/a.ogg')).toBe('custom field value');
  });

  it('throws on a non-2xx response', async () => {
    readFile.mockResolvedValueOnce(Buffer.from('A'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'boom',
    }));
    const client = new TranscriptionClient({ endpoint: 'http://cap:9000', provider });
    await expect(client.transcribeFile('/x/a.ogg')).rejects.toThrow(/500/);
  });

  it('throws when the response field is missing', async () => {
    readFile.mockResolvedValueOnce(Buffer.from('A'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ other: 'x' }),
    }));
    const client = new TranscriptionClient({ endpoint: 'http://cap:9000', provider });
    await expect(client.transcribeFile('/x/a.ogg')).rejects.toThrow(/text/);
  });

  it('propagates a read failure', async () => {
    readFile.mockRejectedValueOnce(new Error('ENOENT'));
    vi.stubGlobal('fetch', vi.fn());
    const client = new TranscriptionClient({ endpoint: 'http://cap:9000', provider });
    await expect(client.transcribeFile('/missing.ogg')).rejects.toThrow(/ENOENT/);
  });
});
```

2. [ ] Run it, expect FAIL:
   `... npx vitest run src/transcription/client.test.ts`
   Expected: `Cannot find module './client.js'`.

3. [ ] Implement. Create `src/transcription/client.ts`:

```ts
/**
 * Config-driven transcription client.
 *
 * Constructed from a discovery entry's endpoint + TranscriptionProviderConfig
 * (no process.env reads, mirroring the RAG provider style). Reads an audio file
 * by absolute path and POSTs it as multipart/form-data to a Whisper-class /
 * OpenAI-compatible audio endpoint, returning the transcript text.
 */
import { readFile } from 'fs/promises';
import { basename } from 'node:path';
import { logger } from '../logger.js';
import { DEFAULT_TRANSCRIPTION_CONFIG } from '../capabilities/transcription-config.js';
import type { TranscriptionProviderConfig } from '../capabilities/types.js';

export interface TranscriptionClientOpts {
  endpoint: string;
  provider: TranscriptionProviderConfig;
}

export class TranscriptionClient {
  private readonly baseUrl: string;
  private readonly provider: TranscriptionProviderConfig;

  constructor(opts: TranscriptionClientOpts) {
    this.baseUrl = opts.endpoint.replace(/\/$/, '');
    this.provider = opts.provider;
  }

  /** Read the file at absPath and POST it; returns the transcript string. */
  async transcribeFile(absPath: string): Promise<string> {
    const bytes = await readFile(absPath);
    const path = this.provider.transcribePath ?? DEFAULT_TRANSCRIPTION_CONFIG.transcribePath;
    const responseField = this.provider.responseField ?? DEFAULT_TRANSCRIPTION_CONFIG.responseField;
    const timeoutMs = this.provider.timeoutMs ?? DEFAULT_TRANSCRIPTION_CONFIG.timeoutMs;

    const form = new FormData();
    form.append('file', new Blob([bytes]), basename(absPath));
    if (this.provider.model) form.append('model', this.provider.model);

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Transcription POST ${path} → ${res.status}: ${body}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    const value = json[responseField];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Transcription response missing string field '${responseField}'`);
    }
    logger.debug({ path, chars: value.length }, 'Transcription succeeded');
    return value;
  }
}
```

4. [ ] Run, expect PASS:
   `... npx vitest run src/transcription/client.test.ts`

5. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**'` then `... npx tsc --noEmit`

6. [ ] Commit:
   `git add -A && git commit -m "feat(transcription): config-driven multipart client (SP3 task 4)"`

---

### Task 5: Transcription preprocessor (marker-driven content transform)

A `transform` preprocessor: scan the prompt with `VOICE_ATTACHMENT_PATTERN`; on no match return identity (fast path). On a match, resolve the `transcription` discovery entry for the current channel; if none, return unchanged (non-fatal). For each marker, read `path.join(GROUPS_DIR, groupFolder, rawPath)`, transcribe via the client, and replace the marker with `[Voice: <transcript>]`. Return the fully-substituted string as **both** `prompt` and `persistedContent`. Any per-marker failure leaves that marker intact (non-fatal).

**Files:**
- Create: `src/runtime/preprocessors/transcription-preprocessor.ts`.
- Test: `src/runtime/preprocessors/transcription-preprocessor.test.ts` (new).

**Interfaces:**
- **Consumes:** `InboundPreprocessor`/`PreprocessorInput`/`PreprocessorResult` from `./types.js`; `VOICE_ATTACHMENT_PATTERN` from `../../attachment-markers.js` (`/\[VoiceAttachment: (attachments\/raw\/[^\s\]]+)\]/g`, capture group 1 = relative raw path); `GROUPS_DIR` from `../../config.js` (`path.resolve(PROJECT_ROOT, 'groups')`); `getTranscriptionEntry` from `../../capabilities/client.js` (Task 6); `TranscriptionClient` from `../../transcription/client.js` (Task 4); `logger`; `node:path.join`.
- **Produces:** `class TranscriptionPreprocessor implements InboundPreprocessor` with `name = 'transcription'`, `effect = 'transform'`. The channel name comes from `process.env.KUBECLAW_CHANNEL ?? '*'` (same convention as `getRagProvider` in `src/rag/provider.ts:196`). A protected/injectable `makeClient(entry)` factory lets tests substitute a fake client.

> **Ordering note:** This task imports `getTranscriptionEntry` from `../../capabilities/client.js`, which Task 6 adds. To keep this commit compiling, the test mocks `../../capabilities/client.js` (so the missing export does not matter at test time), and the SOURCE import would fail `tsc` until Task 6 lands. THEREFORE: do Task 6 (the `getTranscriptionEntry` client export) FIRST is NOT required — instead, this task adds the `getTranscriptionEntry` export to `src/capabilities/client.js` as part of step 3 below (it is a 6-line addition with the same shape as `getRagEntry`), and Task 6 only adds its colocated test + the registry-side glue already present from Task 3. This keeps every commit green. Implement the client export here, test it here, and Task 6 hardens discovery + conflict guard.

**Steps:**

1. [ ] Write the failing test. Create `src/runtime/preprocessors/transcription-preprocessor.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTranscriptionEntry = vi.hoisted(() => vi.fn());
vi.mock('../../capabilities/client.js', () => ({ getTranscriptionEntry }));
vi.mock('../../config.js', () => ({ GROUPS_DIR: '/groups' }));
vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TranscriptionPreprocessor } from './transcription-preprocessor.js';

const ENTRY = {
  kind: 'transcription',
  name: 't',
  endpoint: 'http://cap:9000',
  kindMetadata: { provider: { transcribePath: '/v1/audio/transcriptions', responseField: 'text', timeoutMs: 60000 } },
};

// Build a preprocessor whose client is a fake.
function makePreprocessor(transcribe: (abs: string) => Promise<string>) {
  const p = new TranscriptionPreprocessor();
  (p as unknown as { makeClient: () => { transcribeFile: typeof transcribe } }).makeClient =
    () => ({ transcribeFile: transcribe });
  return p;
}

beforeEach(() => {
  getTranscriptionEntry.mockReset();
  delete process.env.KUBECLAW_CHANNEL;
});

describe('TranscriptionPreprocessor', () => {
  it('is a transform effect named transcription', () => {
    const p = new TranscriptionPreprocessor();
    expect(p.name).toBe('transcription');
    expect(p.effect).toBe('transform');
  });

  it('fast path: no marker → identity, no entry lookup', async () => {
    const p = makePreprocessor(async () => 'NOPE');
    const out = await p.apply({ groupFolder: 'g', prompt: 'just text' });
    expect(out.prompt).toBe('just text');
    expect(out.persistedContent).toBeUndefined();
    expect(getTranscriptionEntry).not.toHaveBeenCalled();
  });

  it('no capability entry → marker left intact, non-fatal', async () => {
    getTranscriptionEntry.mockReturnValue(undefined);
    const p = makePreprocessor(async () => 'X');
    const out = await p.apply({
      groupFolder: 'g',
      prompt: '[VoiceAttachment: attachments/raw/a.ogg]',
    });
    expect(out.prompt).toBe('[VoiceAttachment: attachments/raw/a.ogg]');
    expect(out.persistedContent).toBeUndefined();
  });

  it('substitutes a transcript and sets prompt AND persistedContent', async () => {
    getTranscriptionEntry.mockReturnValue(ENTRY);
    const seen: string[] = [];
    const p = makePreprocessor(async (abs) => {
      seen.push(abs);
      return 'hello there';
    });
    const out = await p.apply({
      groupFolder: 'mygroup',
      prompt: 'before [VoiceAttachment: attachments/raw/a.ogg] after',
    });
    expect(seen).toEqual(['/groups/mygroup/attachments/raw/a.ogg']);
    expect(out.prompt).toBe('before [Voice: hello there] after');
    expect(out.persistedContent).toBe('before [Voice: hello there] after');
  });

  it('handles multiple markers', async () => {
    getTranscriptionEntry.mockReturnValue(ENTRY);
    const p = makePreprocessor(async (abs) =>
      abs.endsWith('a.ogg') ? 'first' : 'second',
    );
    const out = await p.apply({
      groupFolder: 'g',
      prompt: '[VoiceAttachment: attachments/raw/a.ogg] and [VoiceAttachment: attachments/raw/b.ogg]',
    });
    expect(out.prompt).toBe('[Voice: first] and [Voice: second]');
    expect(out.persistedContent).toBe('[Voice: first] and [Voice: second]');
  });

  it('preserves literal $ in the transcript (no replacement-pattern corruption)', async () => {
    getTranscriptionEntry.mockReturnValue(ENTRY);
    const p = makePreprocessor(async () => 'that costs $20 $now');
    const out = await p.apply({
      groupFolder: 'g',
      prompt: '[VoiceAttachment: attachments/raw/a.ogg]',
    });
    // The literal $ must survive verbatim — split/join never interprets $ patterns.
    expect(out.prompt).toBe('[Voice: that costs $20 $now]');
    expect(out.persistedContent).toBe('[Voice: that costs $20 $now]');
  });

  it('per-marker failure leaves that marker intact, transcribes the rest', async () => {
    getTranscriptionEntry.mockReturnValue(ENTRY);
    const p = makePreprocessor(async (abs) => {
      if (abs.endsWith('a.ogg')) throw new Error('non-2xx');
      return 'ok';
    });
    const out = await p.apply({
      groupFolder: 'g',
      prompt: '[VoiceAttachment: attachments/raw/a.ogg] x [VoiceAttachment: attachments/raw/b.ogg]',
    });
    expect(out.prompt).toBe('[VoiceAttachment: attachments/raw/a.ogg] x [Voice: ok]');
    // a transform fired (b succeeded) so persistedContent is set to the substituted text
    expect(out.persistedContent).toBe('[VoiceAttachment: attachments/raw/a.ogg] x [Voice: ok]');
  });

  it('reads KUBECLAW_CHANNEL when resolving the entry', async () => {
    process.env.KUBECLAW_CHANNEL = 'telegram';
    getTranscriptionEntry.mockReturnValue(undefined);
    const p = makePreprocessor(async () => 'X');
    await p.apply({ groupFolder: 'g', prompt: '[VoiceAttachment: attachments/raw/a.ogg]' });
    expect(getTranscriptionEntry).toHaveBeenCalledWith('telegram');
  });

  it('falls back to wildcard channel when KUBECLAW_CHANNEL is unset', async () => {
    getTranscriptionEntry.mockReturnValue(undefined);
    const p = makePreprocessor(async () => 'X');
    await p.apply({ groupFolder: 'g', prompt: '[VoiceAttachment: attachments/raw/a.ogg]' });
    expect(getTranscriptionEntry).toHaveBeenCalledWith('*');
  });
});
```

2. [ ] Run it, expect FAIL:
   `... npx vitest run src/runtime/preprocessors/transcription-preprocessor.test.ts`
   Expected: `Cannot find module './transcription-preprocessor.js'`.

3. [ ] Implement.

   First add `getTranscriptionEntry` to `src/capabilities/client.js` (after `getRagEntry`, lines 6–13):

```ts
export function getTranscriptionEntry(
  channelName: string,
): Extract<CapabilityDiscoveryEntry, { kind: 'transcription' }> | undefined {
  return getEntriesForChannel(channelName).find(
    (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'transcription' }> =>
      e.kind === 'transcription',
  );
}
```

   Create `src/runtime/preprocessors/transcription-preprocessor.ts`:

```ts
/**
 * Voice transcription as the first content transform.
 *
 * Marker-driven (D1): scans the prompt for [VoiceAttachment: attachments/raw/…]
 * markers, reads each audio file from the group PVC at
 * GROUPS_DIR/<groupFolder>/<rawPath>, POSTs it to the discovered transcription
 * capability, and replaces the marker with [Voice: <transcript>]. The
 * substituted text is returned as BOTH prompt and persistedContent (D2) so the
 * transcript — not the marker — is what is stored, indexed, and retrieved
 * against. Non-fatal (D4): no entry, or any per-marker failure, leaves that
 * marker in place and the turn continues.
 */
import { join } from 'node:path';
import { logger } from '../../logger.js';
import { GROUPS_DIR } from '../../config.js';
import { VOICE_ATTACHMENT_PATTERN } from '../../attachment-markers.js';
import { getTranscriptionEntry } from '../../capabilities/client.js';
import { TranscriptionClient } from '../../transcription/client.js';
import type { CapabilityDiscoveryEntry } from '../../capabilities/types.js';
import type {
  InboundPreprocessor,
  PreprocessorInput,
  PreprocessorResult,
} from './types.js';

type TranscriptionEntry = Extract<CapabilityDiscoveryEntry, { kind: 'transcription' }>;

export class TranscriptionPreprocessor implements InboundPreprocessor {
  readonly name = 'transcription';
  readonly effect = 'transform' as const;

  /** Overridable in tests. */
  protected makeClient(entry: TranscriptionEntry): { transcribeFile(abs: string): Promise<string> } {
    return new TranscriptionClient({
      endpoint: entry.endpoint,
      provider: entry.kindMetadata.provider,
    });
  }

  async apply({ groupFolder, prompt }: PreprocessorInput): Promise<PreprocessorResult> {
    // Fast path: collect markers without consuming the global regex's lastIndex.
    const markers = [...prompt.matchAll(new RegExp(VOICE_ATTACHMENT_PATTERN.source, 'g'))];
    if (markers.length === 0) return { prompt };

    const channel = process.env.KUBECLAW_CHANNEL ?? '*';
    const entry = getTranscriptionEntry(channel);
    if (!entry) {
      logger.warn({ groupFolder, channel }, 'voice marker present but no transcription capability; leaving marker');
      return { prompt };
    }

    const client = this.makeClient(entry);
    let result = prompt;
    let anySucceeded = false;

    for (const m of markers) {
      const marker = m[0];
      const rawPath = m[1];
      const absPath = join(GROUPS_DIR, groupFolder, rawPath);
      try {
        const transcript = await client.transcribeFile(absPath);
        // Use split/join instead of String.prototype.replace to avoid `$`
        // sequences in the transcript (e.g. "costs $20") being interpreted as
        // replacement-pattern specials ($&, $1, $', …) and corrupting the output.
        result = result.split(marker).join(`[Voice: ${transcript}]`);
        anySucceeded = true;
      } catch (err) {
        logger.warn({ err, groupFolder, rawPath }, 'transcription failed for marker; leaving it in place');
      }
    }

    if (!anySucceeded) return { prompt };
    return { prompt: result, persistedContent: result };
  }
}
```

   Note on the regex: `VOICE_ATTACHMENT_PATTERN` is a module-level global (`/g`) regex; reusing it directly would share `lastIndex` state across calls. The implementation builds a fresh `RegExp(VOICE_ATTACHMENT_PATTERN.source, 'g')` per call for `matchAll`. Marker substitution uses `split(marker).join(replacement)` (not `String.prototype.replace`) to avoid the JS replacement-pattern substitution rules (`$&`, `$1`, `$'`, etc.) that would corrupt transcripts containing literal `$` characters.

4. [ ] Run, expect PASS:
   `... npx vitest run src/runtime/preprocessors/transcription-preprocessor.test.ts`

5. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**'` then `... npx tsc --noEmit`

6. [ ] Commit:
   `git add -A && git commit -m "feat(transcription): marker-driven transform preprocessor + getTranscriptionEntry (SP3 task 5)"`

---

### Task 6: Discovery hardening — `getTranscriptionEntry` test + one-per-channel conflict guard

`getTranscriptionEntry` was added in Task 5; this task adds its colocated test and the one-per-channel conflict guard (D6) mirroring `assertNoConflictingRag`, wired into `installCapability`. Also adds a registry test that the discovery entry round-trips with **no secrets**.

**Files:**
- Modify: `src/capabilities/registry.ts` — add `assertNoConflictingTranscription` and call it from `installCapability` (line 147, alongside `assertNoConflictingRag`).
- Test: `src/capabilities/client.test.ts` (extend if it exists; else create) — `getTranscriptionEntry` round-trip; extend `src/capabilities/registry.test.ts` — discovery entry + conflict guard.

**Interfaces:**
- **Consumes (Task 3):** `normalizeTranscriptionSpec` (already imported into registry by Task 3); `getTranscriptionEntry` (Task 5).
- **Produces:** `function assertNoConflictingTranscription(spec: CapabilitySpec): void` (module-private, called from `installCapability`).

**Steps:**

1. [ ] Write the failing tests. Add to `src/capabilities/registry.test.ts` (a new `describe` block near the existing `rag discovery entry` tests). The registry test file already imports `specToDiscoveryEntry` and `installCapability`-adjacent helpers; mirror its existing mocking style for `./db.js`/redis (read the file's top mocks first and reuse them):

```ts
  describe('transcription discovery entry', () => {
    it('emits the normalized provider in kindMetadata with NO secrets', () => {
      const entry = specToDiscoveryEntry({
        kind: 'transcription',
        name: 'whisper',
        image: 'onerahmet/openai-whisper-asr-webservice:latest',
      });
      if (entry.kind !== 'transcription') throw new Error('expected transcription entry');
      expect(entry.kindMetadata.provider.transcribePath).toBe('/v1/audio/transcriptions');
      expect(entry.kindMetadata.provider.responseField).toBe('text');
      expect(entry.endpoint).toBe('http://kubeclaw-cap-whisper:9000');
      // No secret/key fields exist on the entry — provider config is the whole shape.
      expect(JSON.stringify(entry)).not.toMatch(/apiKey|secret|token/i);
    });

    it('honours an explicit port', () => {
      const entry = specToDiscoveryEntry({
        kind: 'transcription', name: 'w', image: 'img', port: 8080,
      });
      if (entry.kind !== 'transcription') throw new Error('expected transcription entry');
      expect(entry.endpoint).toBe('http://kubeclaw-cap-w:8080');
    });
  });
```

   Add a conflict-guard test. Mirror the existing `assertNoConflictingRag` test setup in `registry.test.ts` (it drives `installCapability` against a stubbed DB + redis; read how the rag conflict test seeds existing specs and reuse that harness):

```ts
  describe('one-per-channel transcription guard', () => {
    it('rejects a second universal transcription on the same (all) channels', async () => {
      await installCapability({
        kind: 'transcription', name: 't1', image: 'img',
      });
      await expect(
        installCapability({ kind: 'transcription', name: 't2', image: 'img' }),
      ).rejects.toThrow(/transcription/i);
    });

    it('allows two transcriptions with disjoint channel ACLs', async () => {
      await installCapability({
        kind: 'transcription', name: 't1', image: 'img', channels: ['telegram'],
      });
      await expect(
        installCapability({ kind: 'transcription', name: 't2', image: 'img', channels: ['slack'] }),
      ).resolves.toBeUndefined();
    });
  });
```

   If `src/capabilities/client.test.ts` does not exist, create it with the `getRagEntry` test style (mock `./registry.js`'s `getEntriesForChannel`):

```ts
import { describe, it, expect, vi } from 'vitest';

const getEntriesForChannel = vi.hoisted(() => vi.fn());
vi.mock('./registry.js', () => ({ getEntriesForChannel, listCapabilities: vi.fn(() => []) }));
vi.mock('../per-group-capabilities/schema-cache.js', () => ({ getCachedSchemas: vi.fn() }));
vi.mock('../per-group-capabilities/types.js', () => ({ getScope: vi.fn(() => 'cluster') }));

import { getTranscriptionEntry } from './client.js';

describe('getTranscriptionEntry', () => {
  it('returns the first transcription entry for the channel', () => {
    getEntriesForChannel.mockReturnValue([
      { kind: 'rag', name: 'r', endpoint: 'http://r', kindMetadata: {} },
      { kind: 'transcription', name: 't', endpoint: 'http://t', kindMetadata: { provider: {} } },
    ]);
    expect(getTranscriptionEntry('*')?.name).toBe('t');
  });

  it('returns undefined when no transcription entry exists', () => {
    getEntriesForChannel.mockReturnValue([{ kind: 'http', name: 'h', endpoint: 'http://h', kindMetadata: {} }]);
    expect(getTranscriptionEntry('*')).toBeUndefined();
  });
});
```

2. [ ] Run, expect FAIL:
   `... npx vitest run src/capabilities/registry.test.ts src/capabilities/client.test.ts`
   Expected: conflict-guard tests fail (no guard yet); discovery/round-trip tests should already pass from Task 3+5 (if they pass, the only red is the conflict guard).

3. [ ] Implement. In `src/capabilities/registry.ts`, add `assertNoConflictingTranscription` after `assertNoConflictingRag` (after line 144). It is structurally identical to the RAG guard but for `kind === 'transcription'`:

```ts
/**
 * One-per-channel guard for transcription (D6). getTranscriptionEntry() returns
 * the first match, so a second transcription on the same channel silently
 * orphans a pod. Two may coexist only with disjoint `channels` ACLs; an empty/
 * absent ACL means "all channels" and conflicts with any other. Updates to an
 * existing spec (matched by name) are exempt.
 */
function assertNoConflictingTranscription(spec: CapabilitySpec): void {
  if (spec.kind !== 'transcription') return;
  const others = listCapabilitiesByKind('transcription').filter(
    (c) => c.name !== spec.name,
  );
  if (others.length === 0) return;

  const incoming = spec.channels?.length ? new Set(spec.channels) : null;
  for (const other of others) {
    const otherChannels = other.channels?.length ? new Set(other.channels) : null;
    if (incoming === null || otherChannels === null) {
      const universal = incoming === null ? spec.name : other.name;
      throw new Error(
        `Transcription '${spec.name}' conflicts with already-installed transcription '${other.name}': ` +
          `'${universal}' is unscoped (applies to all channels). ` +
          'Each channel may bind at most one transcription. Give both specs disjoint `channels` ACLs, ' +
          `or remove '${other.name}' first.`,
      );
    }
    const overlap = [...incoming].filter((c) => otherChannels.has(c));
    if (overlap.length > 0) {
      throw new Error(
        `Transcription '${spec.name}' conflicts with already-installed transcription '${other.name}' ` +
          `on channel(s): ${overlap.join(', ')}. ` +
          'Each channel may bind at most one transcription. Adjust the `channels` ACLs so they are disjoint, ' +
          `or remove '${other.name}' first.`,
      );
    }
  }
}
```

   Call it in `installCapability` (line 147, right after `assertNoConflictingRag(spec);`):

```ts
  assertNoConflictingRag(spec);
  assertNoConflictingTranscription(spec);
```

4. [ ] Run, expect PASS:
   `... npx vitest run src/capabilities/registry.test.ts src/capabilities/client.test.ts`

5. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**'` then `... npx tsc --noEmit`

6. [ ] Commit:
   `git add -A && git commit -m "feat(transcription): getTranscriptionEntry test + one-per-channel conflict guard (SP3 task 6)"`

---

### Task 7: Builder render test + generic builder confirmation for `transcription`

The generic `transcription` builder arm was added in Task 3 to keep `buildYaml` compiling. This task adds the dedicated render test proving the generic `renderDeploymentAndService` produces a Deployment + Service for `transcription`, honours an explicit port, and applies SP1 `probe`/`startup`/`gpu`/`podSecurity` fields. No per-impl builder is introduced (D5).

**Files:**
- Test: `src/capabilities/builders/transcription.test.ts` (new).
- Modify (only if the render test surfaces a gap): `src/capabilities/builders/index.ts`.

**Interfaces:** none new (confirms Task 3's `buildTranscriptionYaml`).

**Steps:**

1. [ ] Write the test. Create `src/capabilities/builders/transcription.test.ts` (mirror `src/capabilities/builders/rag.test.ts` mocking of `KUBECLAW_NAMESPACE`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { parseAllDocuments } from 'yaml';

vi.mock('../../config.js', () => ({ KUBECLAW_NAMESPACE: 'kubeclaw' }));

import { buildYaml } from './index.js';
import type { TranscriptionCapabilitySpec } from '../types.js';

const base: TranscriptionCapabilitySpec = {
  kind: 'transcription',
  name: 'whisper',
  image: 'onerahmet/openai-whisper-asr-webservice:latest',
};

describe('generic transcription builder', () => {
  it('renders Deployment + Service on the default port 9000', () => {
    const yaml = buildYaml(base);
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('containerPort: 9000');
  });

  it('parses to exactly Deployment + Service (no PVC by default)', () => {
    const docs = parseAllDocuments(buildYaml(base)).map((d) => d.toJSON());
    expect(docs.map((d) => d.kind).sort()).toEqual(['Deployment', 'Service'].sort());
  });

  it('honours an explicit port', () => {
    const yaml = buildYaml({ ...base, port: 8080 });
    expect(yaml).toContain('containerPort: 8080');
  });

  it('applies SP1 gpu, startup probe, and podSecurity fields', () => {
    const yaml = buildYaml({
      ...base,
      resources: { gpu: 1 },
      probe: { type: 'http', path: '/health', startup: { failureThreshold: 60, periodSeconds: 5 } },
      podSecurity: { runAsNonRoot: true },
    });
    expect(yaml).toContain('nvidia.com/gpu');
    expect(yaml).toContain('startupProbe:');
    expect(yaml).toContain('runAsNonRoot: true');
  });
});
```

2. [ ] Run, expect PASS (the builder arm already exists from Task 3):
   `... npx vitest run src/capabilities/builders/transcription.test.ts`
   If any assertion fails (e.g. `startupProbe`/`nvidia.com/gpu` not rendered for this component), the gap is in how `buildTranscriptionYaml` forwards fields to `renderDeploymentAndService` — fix `buildTranscriptionYaml` in `src/capabilities/builders/index.ts` to forward the missing field (compare against `buildRagYaml` which forwards the same set). Re-run until green.

3. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**'` then `... npx tsc --noEmit`

4. [ ] Commit:
   `git add -A && git commit -m "test(transcription): generic builder render test (SP3 task 7)"`

---

### Task 8: channel-runner sync accepts `transcription` entries

The channel pod mirrors discovery entries into its local SQLite so `getTranscriptionEntry` resolves them. Add a `transcription` case to `syncCapabilitiesToLocalDb`, widen the two `kindMetadata` lite types to carry the transcription provider, and reset on `capabilities_update`. The existing `resetRagProvider()` call already fires on every update; transcription is stateless (the preprocessor constructs a fresh client from the entry per turn), so no `resetTranscriptionProvider()` is needed — call this out explicitly.

**Files:**
- Modify: `src/channel-runner.ts` — the `handleCapabilitiesUpdate` payload `kindMetadata` lite type (lines 172–177), the `DiscoveryEntryLite.kindMetadata` type (lines 241–246), and `syncCapabilitiesToLocalDb` switch (add a `transcription` case after the `http` case at line 301–303).
- Test: `src/channel-runner.sync.test.ts` (extend — this file exists from SP2 Task 5; add transcription cases mirroring the rag ones).

**Interfaces:**
- **Consumes:** `TranscriptionProviderConfig` from `./capabilities/types.js`; `setCapability`/`getAllCapabilities` from `./capabilities/db.js` (already imported).
- **Produces:** local DB rows for transcription entries carrying `provider`, so `specToDiscoveryEntry` → `getTranscriptionEntry` re-derives the same `kindMetadata.provider`.

**Steps:**

1. [ ] Write the failing test. Add to `src/channel-runner.sync.test.ts` (reuse the file's existing `_initTestDatabase`/`__resetDbForTest`/`handleCapabilitiesUpdate` harness from SP2 Task 5):

```ts
it('mirrors a transcription entry with its provider config into local DB', async () => {
  await handleCapabilitiesUpdate({
    capabilities: JSON.stringify([{
      name: 'whisper', kind: 'transcription', endpoint: 'http://kubeclaw-cap-whisper:9000',
      kindMetadata: { provider: { transcribePath: '/v1/audio/transcriptions', responseField: 'text', timeoutMs: 60000 } },
    }]),
  } as never);
  const rows = getAllCapabilities().filter((c) => c.kind === 'transcription');
  expect(rows).toHaveLength(1);
  expect((rows[0] as { provider?: { transcribePath?: string } }).provider?.transcribePath)
    .toBe('/v1/audio/transcriptions');
});

it('skips a transcription entry missing its provider block', async () => {
  await handleCapabilitiesUpdate({
    capabilities: JSON.stringify([{
      name: 'bad', kind: 'transcription', endpoint: 'http://x:9000',
      kindMetadata: {},
    }]),
  } as never);
  expect(getAllCapabilities().filter((c) => c.kind === 'transcription')).toHaveLength(0);
});
```

2. [ ] Run, expect FAIL:
   `... npx vitest run src/channel-runner.sync.test.ts`
   Expected: transcription rows are not written (no case in the sync switch; falls through `default: continue`).

3. [ ] Implement. In `src/channel-runner.ts`:

   Do NOT widen the shared `kindMetadata` lite types for transcription. The discovery entry for transcription uses `kindMetadata.provider` (a `TranscriptionProviderConfig`), the same key name RAG uses for `RagProviderConfig`. Adding a second field (`transcriptionProvider?`) would be misleading and wrong. Instead, in the `transcription` sync case read the provider via a local guarded cast:

```ts
(entry.kindMetadata as { provider?: TranscriptionProviderConfig }).provider
```

   disambiguated by `entry.kind === 'transcription'` (the enclosing switch arm) and the belt-and-suspenders `!('adapter' in provider)` check (RAG providers always carry `adapter`; transcription providers never do). The shared lite `provider?: RagProviderConfig` field is NOT widened — doing so would collapse two distinct types onto one key and mislead future readers into thinking RAG config and transcription config are the same shape.

   Add the `transcription` case to the `syncCapabilitiesToLocalDb` switch (after the `http` case at line 303, before `default:`):

```ts
      case 'transcription': {
        const provider = (
          entry.kindMetadata as {
            provider?: import('./capabilities/types.js').TranscriptionProviderConfig;
          }
        ).provider;
        // Skip a malformed entry (no provider block) rather than write a bad row.
        if (!provider || typeof provider !== 'object' || 'adapter' in provider) {
          continue;
        }
        spec = {
          ...common,
          kind: 'transcription',
          provider,
        };
        break;
      }
```

   > The `'adapter' in provider` check distinguishes a transcription provider from a RAG provider (RAG providers always carry `adapter`); combined with `entry.kind === 'transcription'` it is belt-and-suspenders against a mis-shaped payload.

4. [ ] Run, expect PASS:
   `... npx vitest run src/channel-runner.sync.test.ts`

5. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**'` then `... npx tsc --noEmit`

6. [ ] Commit:
   `git add -A && git commit -m "feat(transcription): channel-runner mirrors transcription provider config (SP3 task 8)"`

---

### Task 9: Wire the chain into `direct-llm-runner.ts`

Replace the bespoke `augmentPrompt` block with `runPreprocessorChain`, make the chain injectable on the runner for tests, default it to `[TranscriptionPreprocessor, RagPreprocessor]`, and thread the chain's `persistedContent` into the persist (line 1410) and index (line 1441) sites. RAG behaviour MUST be byte-identical when no voice marker is present (regression).

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts`:
  - imports (line 28): keep `getRagProvider` (still used at line 1441 for `indexConversationTurn`); drop `augmentPrompt` from that import (no longer called directly). Add the chain + registry imports.
  - the class field/constructor (lines 928–954): add an injectable `preprocessors?` field.
  - the augment block (lines 1126–1145): replace with the chain call.
  - persist (line 1410) + index (lines 1441–1445): use the chain's `persistedContent`.
- Create: `src/runtime/preprocessors/registry.ts` — `buildDefaultPreprocessors()`.
- Test: `src/runtime/preprocessors/registry.test.ts` (new); `src/runtime/direct-llm-runner.preprocessors.test.ts` (new) — drive `runAgent` with injected fakes mirroring the existing `src/runtime/direct-llm-runner.rag.test.ts` harness from SP2 Task 6.

**Interfaces:**
- **Consumes (Tasks 1, 2, 5):** `runPreprocessorChain`, `ChainOutput` from `./preprocessors/chain.js`; `buildDefaultPreprocessors` from `./preprocessors/registry.js`; `InboundPreprocessor` from `./preprocessors/types.js`.
- **Produces:** `function buildDefaultPreprocessors(): InboundPreprocessor[]` returning `[new TranscriptionPreprocessor(), new RagPreprocessor()]` (registration order = transcription then RAG — transforms run first regardless, but this order also fixes the per-phase order).

**Steps:**

1. [ ] Write the registry test. Create `src/runtime/preprocessors/registry.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../rag/provider.js', () => ({ augmentPrompt: vi.fn() }));
vi.mock('../../capabilities/client.js', () => ({ getTranscriptionEntry: vi.fn() }));
vi.mock('../../config.js', () => ({ GROUPS_DIR: '/groups' }));
vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildDefaultPreprocessors } from './registry.js';

describe('buildDefaultPreprocessors', () => {
  it('returns transcription (transform) then rag (augment)', () => {
    const chain = buildDefaultPreprocessors();
    expect(chain.map((p) => p.name)).toEqual(['transcription', 'rag']);
    expect(chain.map((p) => p.effect)).toEqual(['transform', 'augment']);
  });
});
```

2. [ ] Run, expect FAIL:
   `... npx vitest run src/runtime/preprocessors/registry.test.ts`
   Expected: `Cannot find module './registry.js'`.

3. [ ] Implement the registry. Create `src/runtime/preprocessors/registry.ts`:

```ts
/**
 * Default inbound-preprocessor chain for a channel pod.
 *
 * Registration order: transcription (transform) then RAG (augment). The chain
 * runs all transforms before all augmenters regardless, so transcription always
 * precedes RAG; this order also pins the within-phase order.
 */
import { TranscriptionPreprocessor } from './transcription-preprocessor.js';
import { RagPreprocessor } from './rag-preprocessor.js';
import type { InboundPreprocessor } from './types.js';

export function buildDefaultPreprocessors(): InboundPreprocessor[] {
  return [new TranscriptionPreprocessor(), new RagPreprocessor()];
}
```

4. [ ] Run, expect PASS:
   `... npx vitest run src/runtime/preprocessors/registry.test.ts`

5. [ ] Write the failing runner test. First READ `src/runtime/direct-llm-runner.rag.test.ts` (the SP2 Task 6 harness) to copy its OpenAI-client mock, conversation-history mocks, and minimal `RegisteredGroup`/`ContainerInput` setup verbatim. Create `src/runtime/direct-llm-runner.preprocessors.test.ts` using that exact harness, but instead of mocking `../rag/provider.js`'s `augmentPrompt`, inject a fake chain via the runner's new `preprocessors` field:

```ts
// Reuse the OpenAI client mock + conversation-history capture from
// direct-llm-runner.rag.test.ts (copy its top-of-file mocks verbatim).
// Additionally keep getRagProvider mocked so indexConversationTurn is observable:
const indexConversationTurn = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../rag/provider.js', () => ({
  augmentPrompt: vi.fn(),
  getRagProvider: () => ({ indexConversationTurn, retrieveContext: async () => '' }),
}));

import type { InboundPreprocessor } from './preprocessors/types.js';

// A fake transcription transform + fake rag augment, injected on the runner.
const fakeTranscription: InboundPreprocessor = {
  name: 'transcription', effect: 'transform',
  async apply({ prompt }) {
    if (!prompt.includes('[VoiceAttachment:')) return { prompt };
    const out = prompt.replace(/\[VoiceAttachment:[^\]]+\]/, '[Voice: hello world]');
    return { prompt: out, persistedContent: out };
  },
};
const fakeRag: InboundPreprocessor = {
  name: 'rag', effect: 'augment',
  async apply({ prompt }) {
    return { prompt: `<retrieved_context>\nMEM\n</retrieved_context>\n\n${prompt}` };
  },
};

it('transcribes the voice marker, augments the transcript, and the LLM turn sees both', async () => {
  // Build the runner; set runner.preprocessors = [fakeTranscription, fakeRag].
  // Drive runAgent with ContainerInput { prompt: '[VoiceAttachment: attachments/raw/a.ogg]', groupFolder: 'g' }.
  const userMsg = capturedMessages.find((m) => m.role === 'user');
  expect(userMsg.content).toContain('<retrieved_context>');
  expect(userMsg.content).toContain('[Voice: hello world]');
  expect(userMsg.content).not.toContain('[VoiceAttachment:');
});

it('persists + indexes the transcript, NOT the marker and NOT the augmented prompt', async () => {
  // assert the conversation-history capture and indexConversationTurn received
  // '[Voice: hello world]' with NO <retrieved_context> and NO [VoiceAttachment:.
  expect(persistedUser).toContain('[Voice: hello world]');
  expect(persistedUser).not.toContain('<retrieved_context>');
  expect(persistedUser).not.toContain('[VoiceAttachment:');
  expect(indexConversationTurn).toHaveBeenCalledWith('g', '[Voice: hello world]', expect.any(String));
});

it('REGRESSION: no voice marker → byte-identical to SP2 (augmented prompt to LLM, original persisted)', async () => {
  // Drive runAgent with prompt 'hello' (no marker).
  const userMsg = capturedMessages.find((m) => m.role === 'user');
  expect(userMsg.content).toBe('<retrieved_context>\nMEM\n</retrieved_context>\n\nhello');
  expect(persistedUser).toBe('hello');
  expect(indexConversationTurn).toHaveBeenCalledWith('g', 'hello', expect.any(String));
});
```

   Note: how `preprocessors` is injected depends on the field added in step 6 — if it is a public field, set `runner.preprocessors = [...]` before `runAgent`; if a constructor arg, pass it. Step 6 makes it a public mutable field for test simplicity.

6. [ ] Run the runner test, expect FAIL:
   `... npx vitest run src/runtime/direct-llm-runner.preprocessors.test.ts`
   Expected: chain not wired — user message has no `[Voice: …]`, and `persistedUserContent` is still `stripContextHeader(input.prompt)` (the marker, not the transcript).

7. [ ] Implement in `src/runtime/direct-llm-runner.ts`.

   Update the import at line 28 (drop `augmentPrompt`, keep `getRagProvider`):

```ts
   import { getRagProvider } from '../rag/provider.js';
```

   Add new imports near the other `../runtime`/preprocessor-relative imports:

```ts
   import { runPreprocessorChain } from './preprocessors/chain.js';
   import { buildDefaultPreprocessors } from './preprocessors/registry.js';
   import type { InboundPreprocessor } from './preprocessors/types.js';
```

   Add an injectable field to the class (after the `toolCatalog` field at lines 940–942):

```ts
  /**
   * Inbound preprocessor chain (transcription → RAG). Injectable for tests;
   * defaults to buildDefaultPreprocessors() lazily in runAgent.
   */
  preprocessors?: InboundPreprocessor[];
```

   Replace the augment block (lines 1126–1145) with the chain. Replace exactly:

```ts
    // RAG retrieval (non-fatal): prefix any retrieved context onto the user
    // turn. augmentPrompt returns the original prompt unchanged when RAG is
    // disabled or retrieval fails. We augment ONLY the live LLM turn — the
    // persisted history (persistedUserContent below) keeps the original text
    // so stored conversation is not polluted with ephemeral context.
    let augmentedPrompt: string;
    try {
      augmentedPrompt = await augmentPrompt(input.groupFolder, input.prompt);
    } catch {
      augmentedPrompt = input.prompt;
    }

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...(activeSummaryMarker
        ? [{ role: 'system' as const, content: activeSummaryMarker }]
        : []),
      ...history.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: augmentedPrompt },
    ];
```

   with:

```ts
    // Inbound-preprocessor chain (non-fatal): content transforms (e.g. voice →
    // text) run first and define the canonical user content; prompt augmenters
    // (e.g. RAG <retrieved_context>) run after, prefixing the LLM-facing prompt
    // only. The chain returns:
    //   - augmentedPrompt    → the live LLM turn (post-transform, post-augment)
    //   - canonicalUserText  → persisted + indexed (post-transform, PRE-augment)
    // The chain never throws; on any per-preprocessor failure that stage is a
    // no-op, so a broken capability degrades gracefully.
    const chain = this.preprocessors ?? buildDefaultPreprocessors();
    const { prompt: augmentedPrompt, persistedContent: canonicalUserText } =
      await runPreprocessorChain(chain, input.groupFolder, input.prompt);

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...(activeSummaryMarker
        ? [{ role: 'system' as const, content: activeSummaryMarker }]
        : []),
      ...history.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: augmentedPrompt },
    ];
```

   Thread the canonical text into persistence. Replace line 1410:

```ts
      const persistedUserContent = stripContextHeader(input.prompt);
```

   with:

```ts
      // Persist the canonical user content produced by the preprocessor chain
      // (the transcript when voice was present; otherwise the original prompt),
      // with the ephemeral <context …/> header stripped. When no transform
      // fired, canonicalUserText === input.prompt, so this is byte-identical to
      // the prior behaviour.
      const persistedUserContent = stripContextHeader(canonicalUserText);
```

   The index call at lines 1441–1445 already uses `persistedUserContent`, so it now indexes the transcript automatically — leave it unchanged.

8. [ ] Run the runner test, expect PASS:
   `... npx vitest run src/runtime/direct-llm-runner.preprocessors.test.ts`

9. [ ] Run the SP2 RAG regression test too (it must still pass — `augmentPrompt` is no longer called directly there, but the SP2 test mocks `../rag/provider.js`; if `src/runtime/direct-llm-runner.rag.test.ts` asserted `augmentPrompt` was called by the runner, that assertion is now stale because the runner calls the chain, which calls `RagPreprocessor`, which calls `augmentPrompt` — but the SP2 test mocks the whole `../rag/provider.js` module so `RagPreprocessor` would use the mock too). READ that test: if it injects no `preprocessors` field, the runner builds the default chain whose `RagPreprocessor` calls the mocked `augmentPrompt` — the assertion `augmentPrompt was called with ('g', 'hello')` still holds. If it breaks, update it to inject `[new RagPreprocessor()]` or assert on the captured user message instead. Run:
   `... npx vitest run src/runtime/direct-llm-runner.rag.test.ts`

10. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**'` then `... npx tsc --noEmit`

11. [ ] Commit:
   `git add -A && git commit -m "feat(preprocessors): wire runPreprocessorChain into the agent loop; thread transcript into persist+index (SP3 task 9)"`

---

### Task 10: Docs — transcription capability install recipe

Add a documented transcription-capability install recipe to `docs/INSTALLING_A_CHANNEL.md` and list `transcription` alongside `rag`/`mcp`/`http`. Docs-only — no unit/integration/e2e level applies; state this explicitly in the report.

**Files:**
- Modify: `docs/INSTALLING_A_CHANNEL.md` — the capability shape decision tree (line 81–85) and a new subsection after the "Installing Qdrant as a RAG capability" section (which currently ends before line 203).
- (No code; no test level applies.)

**Interfaces:** none.

**Steps:**

1. [ ] No automated test (docs-only). State in the commit and report: "Docs task — no unit/integration/e2e level applies; verified by rendering review."

2. [ ] Implement. In `docs/INSTALLING_A_CHANNEL.md`, update the decision-tree row for voice (line 85) so transcription is no longer described as source-code-only — replace:

```
| An inline preprocessing pipeline (image resize, PDF text extraction, voice transcription) that runs inside channel/orchestrator pods | Source code change via `/customize` (see ADDING_A_CHANNEL.md for the markers contract) |
```

   with:

```
| Voice transcription (Whisper-class STT) | A `transcription` capability — install the spec via the admin shell (see "Installing voice transcription" below). The channel-side preprocessor reads the `[VoiceAttachment: …]` marker and calls it automatically. |
| An inline preprocessing pipeline (image resize, PDF text extraction) that runs inside channel/orchestrator pods | Source code change via `/customize` (see ADDING_A_CHANNEL.md for the markers contract) |
```

   Add a new subsection right after the "Installing Qdrant as a RAG capability" section:

### Installing voice transcription as a `transcription` capability

Voice notes arrive at channels as an audio file on the group PVC plus a
`[VoiceAttachment: attachments/raw/<file>]` marker in the message text. Install a
Whisper-class STT server as a `transcription` capability; the channel-side
inbound-preprocessor chain detects the marker, POSTs the audio to the capability,
and replaces the marker with the transcript BEFORE the LLM turn — so the model,
stored history, and RAG all see the spoken words, not the marker.

Spec (passed to the admin shell `install_capability` tool / Redis IPC). This uses
an OpenAI-compatible image, so it installs as pure config:

```json
{
  "kind": "transcription",
  "name": "whisper",
  "image": "onerahmet/openai-whisper-asr-webservice:latest",
  "port": 9000,
  "env": { "ASR_ENGINE": "faster_whisper", "ASR_MODEL": "base.en" },
  "resources": { "gpu": 1, "memoryRequest": "2Gi", "memoryLimit": "4Gi" },
  "probe": {
    "type": "http",
    "path": "/health",
    "startup": { "failureThreshold": 60, "periodSeconds": 5 }
  },
  "endpointScheme": "http",
  "provider": {
    "transcribePath": "/v1/audio/transcriptions",
    "model": "base.en",
    "responseField": "text",
    "timeoutMs": 60000
  }
}
```

Notes:

- The `startup` probe (SP1) guards liveness/readiness while the model warms up —
  GPU images can take a minute to load weights.
- `provider.transcribePath` defaults to `/v1/audio/transcriptions` (OpenAI audio
  API shape). For images that expose `/asr` (e.g. the ASR webservice's native
  route) set `transcribePath: "/asr"` and `responseField` to match its JSON.
- One transcription capability per channel (give disjoint `channels` ACLs to run
  more than one). No API key is needed for in-cluster STT; if a hosted STT
  backend needs one, deliver it via `envFromSecrets` — the key never appears in
  the spec or the discovery entry.

A backend speaking the OpenAI audio shape installs with no code change.

3. [ ] Verify the markdown renders (read it back; ensure code fences balance and the decision-tree table still parses).

4. [ ] Commit:
   `git add -A && git commit -m "docs(capabilities): voice transcription capability install recipe (SP3 task 10)"`

---

### Task 11: E2E — transcription capability install → marker → transcript reaches LLM (live run deferred)

Write a minikube e2e that installs a transcription capability (small Whisper-class image with an SP1 `startup` probe to prove slow-warm reaches Ready), drops a short audio file into a group's `attachments/raw/`, sends a turn whose prompt carries the `[VoiceAttachment: …]` marker, and asserts the transcript reached the LLM and was persisted/indexed. A second case asserts a no-voice turn is unchanged (RAG-only path). Per the unattended-cluster policy the live run is DEFERRED; the test is written, type-checks, and lints.

**Files:**
- Create: `e2e/minikube-live-transcription.test.ts` (model the structure on `e2e/minikube-live-rag.test.ts` — read it for the install-XADD pattern, group-folder fixture writes, channel-pod log assertions, and the `RAG_CAPABILITY_NAME`/service-name conventions).
- (Optional) Modify: `e2e/minikube-live-setup.ts` only if a shared fixture (e.g. a sample audio asset) needs adding; do NOT change shared setup unless required — grep first.
- Test: this IS the e2e test.

**Interfaces:** none.

**Steps:**

1. [ ] Read `e2e/minikube-live-rag.test.ts` end-to-end first; copy its Redis-XADD install pattern, its readiness poll on the capability Service, and its channel-pod log-grep assertions. Write `e2e/minikube-live-transcription.test.ts` with:

   - An install XADD with the transcription spec (use a deterministic tiny STT image; if none is available in the cluster's registry, use `onerahmet/openai-whisper-asr-webservice:latest` with `ASR_MODEL: tiny.en`, `transcribePath: '/asr'`, `responseField: 'text'`, and an SP1 `startup` probe). Wait for the capability pod to reach Ready (proving slow-warm).
   - Fixture: write a short known WAV/OGG to `groups/<TEST_GROUP>/attachments/raw/sample.ogg` inside the channel pod's PVC (mirror how the rag test seeds group files), and the matching `[VoiceAttachment: attachments/raw/sample.ogg]` into the inbound message.
   - Assert (deterministically, not on exact LLM output): the channel pod logged the transcription path ran (e.g. `Transcription succeeded`) and that the persisted conversation row / index contains the transcript text (assert via the same DB/index inspection the rag test uses), and the user turn sent to the LLM contained `[Voice: ` not `[VoiceAttachment: `.
   - Second case: a turn with NO marker → assert no transcription log line and the RAG-only path behaves as in SP2.

2. [ ] Run, expect SKIP/DEFER (no live cluster here). Document the run command for when a cluster is available:
   `cd /home/peter/projects/kubeclaw/.worktrees/cap-overhaul && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null && npx vitest run e2e/minikube-live-transcription.test.ts`
   Per house policy on unattended clusters, the live run is **deferred**. Verify the test file type-checks and lints:
   `... npx tsc --noEmit` and `... npx eslint e2e/minikube-live-transcription.test.ts`.

3. [ ] No implementation beyond the test file (the feature is wired by Tasks 1–9).

4. [ ] Regression: the non-e2e suite is still green:
   `... npx vitest run --exclude 'e2e/**'`

5. [ ] Commit:
   `git add -A && git commit -m "test(e2e): transcription capability install → marker → transcript (live-run deferred) (SP3 task 11)"`

---

## Self-Review

**Spec coverage (every Design section / Decision → task):**
- §1 Preprocessor framework — `types.ts` + `chain.ts` (`runPreprocessorChain`, transform→augment, non-fatal) → **Task 1**. `registry.ts` (`buildDefaultPreprocessors`) → **Task 9**.
- §2 RAG as first augmenter — `rag-preprocessor.ts` over unchanged `augmentPrompt`; byte-identical regression → **Task 2** (regression pinned again at runner level in **Task 9**).
- §3 Transcription preprocessor — marker scan, group-PVC read, client call, `[Voice: …]` substitution, both `prompt`+`persistedContent` → **Task 5**. The client (multipart POST from discovery config) → **Task 4**.
- §4 Runner wiring — replace RAG block with chain (line 1126–1145), thread `persistedContent` into persist (1410) + index (1441), injectable `preprocessors` → **Task 9**.
- §5 Transcription capability kind — types + discovery member + `CapabilityKind` → **Task 3**; `transcription-config.ts` defaults + `normalizeTranscriptionSpec` → **Task 3**; `registry.ts` `defaultPort`/`specToDiscoveryEntry`/conflict guard → **Tasks 3 (port+entry) + 6 (guard)**; `client.ts` `getTranscriptionEntry` → **Task 5 (added) + 6 (tested)**; generic builder → **Tasks 3 (arm) + 7 (render test)**; channel-runner sync + reset note → **Task 8**.
- §6 Install recipe & docs → **Task 10**.
- Decisions: D1 (channel-side marker-driven, no `runPreprocessingJob`, no `ContainerInput` change) → Tasks 5/9 (no `ContainerInput` edit anywhere). D2 (`apply`→`{prompt, persistedContent?}`, transforms set both) → Tasks 1/2/5. D3 (transforms before augmenters) → Task 1. D4 (non-fatal) → Tasks 1/2/5. D5 (new kind mirroring rag) → Tasks 3/7. D6 (one per channel) → Task 6. D7 (multipart, `transcribePath`/`model`/`responseField`/`timeoutMs`, default port 9000) → Tasks 3/4.
- Tests three levels: unit (Tasks 1–8, colocated), integration (Task 6 registry discovery round-trip + conflict guard, Task 8 channel sync, Task 9 chain-in-runner seam), e2e (Task 11, written, live-run deferred). Docs task (10) explicitly flagged as no-test-level.

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N" left as the substance of any step. Every code-changing step shows the exact code. Two "read the existing harness first" notes (Task 6 registry conflict harness, Task 9 runner harness) point at concrete existing files (`registry.test.ts`, `direct-llm-runner.rag.test.ts`) — guidance for mocking boilerplate, not a stand-in for the change, which is shown.

**Type/name consistency:** `PreprocessorEffect`/`PreprocessorInput`/`PreprocessorResult`/`InboundPreprocessor` (Task 1) are consumed verbatim by Tasks 2 (`RagPreprocessor implements InboundPreprocessor`), 5 (`TranscriptionPreprocessor`), 9 (`buildDefaultPreprocessors(): InboundPreprocessor[]`, runner field type). `ChainOutput { prompt; persistedContent }` (Task 1) is destructured in Task 9 as `{ prompt: augmentedPrompt, persistedContent: canonicalUserText }`. `TranscriptionProviderConfig` (Task 3) is consumed by Task 4 (`TranscriptionClientOpts.provider`), Task 5 (entry `kindMetadata.provider`), Task 8 (sync cast). `TranscriptionCapabilitySpec` (Task 3) flows into `CapabilitySpec` union → `defaultPort`/`buildYaml`/`specToDiscoveryEntry` arms (Task 3) and `buildTranscriptionYaml` (Tasks 3/7). `getTranscriptionEntry` (Task 5) returns `Extract<CapabilityDiscoveryEntry, {kind:'transcription'}>`, consumed by Task 5's preprocessor and tested in Task 6. Default port 9000 is consistent across `registry.ts` (`TRANSCRIPTION_DEFAULT_PORT`), `builders/index.ts`, the builder test (Task 7), and the docs recipe (Task 10). `transcribePath` default `/v1/audio/transcriptions` is consistent across `transcription-config.ts`, `client.ts`, and the client/registry tests.

**Green-on-every-commit ordering (risks designed around):**
- **The union-widening landmine.** Adding `transcription` to `CapabilitySpec` (Task 3) makes the exhaustive `switch (spec.kind)` in `defaultPort` and `buildYaml` non-exhaustive → `tsc` red. Resolved by adding BOTH minimal arms (port case + generic builder case) IN Task 3, so Task 3's commit compiles. Task 7 only adds a render test (no red gap), Task 6 only adds the conflict guard + tests.
- **The `getTranscriptionEntry` import-before-export landmine.** Task 5's preprocessor imports `getTranscriptionEntry` from `capabilities/client.js`. Resolved by adding that export AS PART OF Task 5 step 3 (it is shown in full), so Task 5's commit compiles; Task 6 adds its test + the conflict guard. No commit references an unexported symbol.
- **The lite-type mistyping landmine (Task 8).** The transcription discovery entry reuses the `kindMetadata.provider` key with a DIFFERENT type (`TranscriptionProviderConfig`, no `adapter`) than RAG's `provider` (`RagProviderConfig`, always `adapter`). Resolved by NOT adding a second field to the channel-runner lite types and instead reading the transcription provider via a local cast guarded by `entry.kind === 'transcription'` and `!('adapter' in provider)`. The plan flags the misleading first-draft `transcriptionProvider?` snippet and overrides it explicitly.
- **The SP2 RAG runner test landmine (Task 9).** Replacing the direct `augmentPrompt` call with the chain could break `direct-llm-runner.rag.test.ts`. Resolved: Task 9 step 9 instructs reading that test and confirms its module-level `../rag/provider.js` mock still satisfies it (the default chain's `RagPreprocessor` calls the mocked `augmentPrompt`), with a concrete fallback (inject `[new RagPreprocessor()]` or assert on the captured user message) if the call-site assertion is stale.
- Every task ends with `npx vitest run --exclude 'e2e/**'` and `npx tsc --noEmit` before its commit, so cross-file breakage is caught at each step.
