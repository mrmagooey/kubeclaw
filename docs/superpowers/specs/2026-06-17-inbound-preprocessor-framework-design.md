# Inbound-Preprocessor Framework + Voice Transcription (SP3) — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Builds on:** SP1 ([2026-06-17-capability-base-generalization-design.md](2026-06-17-capability-base-generalization-design.md)) — `probe` (http/tcp + `startup` slow-warm), `scheduling` (GPU/nodeSelector/tolerations/runtimeClassName), `gpu` resource, `endpointScheme`. And SP2 ([2026-06-17-config-driven-rag-capabilities-design.md](2026-06-17-config-driven-rag-capabilities-design.md)) — config-on-spec, the adapter/provider pattern, `kindMetadata.provider` discovery, normalize-on-read back-compat, the generic builder, the per-channel conflict guard, and the now-wired `augmentPrompt` RAG seam in `direct-llm-runner.ts`.

## Where this fits (decomposition)

```
SP1  Capability base generalization                 ✅ COMPLETE
SP2  Config-driven RAG + Qdrant install + retrieval  ✅ COMPLETE (in this branch)
SP3  Inbound-preprocessor framework + voice transcription   ← THIS SPEC
SP4  Capability composition (doc-parse → rag)        (optional, later)
```

SP3 generalizes the one-off RAG-augmentation seam SP2 wired into the agent loop into a small, ordered **inbound-preprocessor chain**, and adds **voice transcription** as the second consumer of that chain — backed by a new `transcription` capability kind that reuses SP1's GPU/slow-start machinery and SP2's config-on-spec/discovery pattern.

## Problem

After SP2, the channel-side agent loop has exactly one pre-LLM hook: a hardcoded `augmentPrompt(input.groupFolder, input.prompt)` call in `direct-llm-runner.ts` (~line 1133) that prepends `<retrieved_context>` to the live turn. This is the only place inbound text is transformed before the LLM call, and it is bespoke to RAG:

1. **The seam is single-purpose and not reusable.** A second pre-LLM transformer (voice → text) has nowhere to plug in. It would have to be a second hardcoded call with its own error handling, ordering rules, and persist/index interaction — duplicating the careful "augment the live turn only, persist the original" contract SP2 established.

2. **Two transformers need different effect semantics.** RAG is **prompt augmentation**: it prepends context but the persisted/indexed content must stay the original text (SP2's contract, enforced via `persistedUserContent` at line ~1410). Transcription is a **content transform**: the user's actual words arrive as an audio file referenced by a `[VoiceAttachment: …]` marker in the prompt, and the *replacement text becomes the real user content* — it must be what gets persisted and indexed, and it must be what RAG retrieves against. A single seam with one effect type cannot express both.

3. **Ordering matters and is currently implicit.** RAG must retrieve against the *transcribed* text, not the literal `[VoiceAttachment: …]` marker. Today there is no transcription step, so the question never arises; adding one naively (a second call after `augmentPrompt`) would retrieve against the marker and index the augmented prompt — both wrong.

4. **Voice transcription has no home.** Audio arrives at channels and is written to disk (group PVC) with a `[VoiceAttachment: attachments/raw/<file>]` marker placed in the message text (`src/attachment-markers.ts`), but **nothing consumes that marker** — `runPreprocessingJob` (the scaffolded K8s job in `src/k8s/job-runner.ts` / `src/runtime/index.ts`) is never called from the inbound path and has no `attachment-preprocessor.js` implementation. There is no transcription capability kind, no Whisper-class pod, and no client.

## Goal

Introduce a channel-side **`InboundPreprocessor` chain** applied to an inbound turn immediately before the LLM call, supporting two effect types (**content transform** and **prompt augmentation**) in a fixed order (transforms first, then augmentation). Refactor the existing RAG `augmentPrompt` call into the chain as the first registered preprocessor with **byte-for-byte preserved behaviour** (regression). Add **voice transcription** as the second preprocessor, backed by a new `transcription` capability kind discovered exactly like `rag` and deployed as a normal SP1 capability pod (GPU/slow-start). A failing preprocessor is **non-fatal** — it is skipped and the turn continues.

## Inbound-attachment investigation (grounding — read before the design)

**Question:** does an inbound user message carry binary/audio attachments to the point where a transcription step could run *before* the LLM turn?

**Verdict: audio does NOT reach the runner as binary — but it IS reachable by path, which is sufficient. NOT a scope blocker.**

Evidence:

- The runner input type `ContainerInput` (`src/runtime/types.ts:18-33`) has **no** attachment/media/audio/binary field — only `prompt: string` plus routing scalars. The OpenAI `messages` array built at `direct-llm-runner.ts:1138-1145` is text-only.
- Channels download attachments and **write the bytes to disk**, then place a **text marker** in the message content. For the HTTP channel: bytes are written to `GROUPS_DIR/<jid>/attachments/raw/<filename>` (`src/channels/http.ts:1289-1320`) and a `[ImageAttachment: attachments/raw/<file> …]` marker is inserted (`src/channels/http.ts:1324-1325`); oauth-webchat mirrors this (`src/channels/oauth-webchat.ts:919-927`). The marker (text) travels via `NewMessage.content` (`src/types.ts`) → `formatMessages` (`src/router.ts:13-27`) → `prompt` → `ContainerInput`.
- Voice markers are first-class in the scaffold: `voiceAttachmentMarker()` / `VOICE_ATTACHMENT_PATTERN` (`src/attachment-markers.ts:35-36,84-86`) and the `inboundVoice` channel capability with its documented "Marker" pattern (`src/types.ts:168-170`). But **no source consumes the voice marker**: `runPreprocessingJob` is defined (`src/k8s/job-runner.ts:1522`, `src/runtime/index.ts:101`) yet **never called** outside its own definition, and `attachment-preprocessor.js` (its container entrypoint) **does not exist in `src/`**. So the existing "preprocessing pipeline" is an unwired skeleton.

**Why this is enough for SP3.** The channel pod that runs `DirectLLMRunner` mounts the same `GROUPS_DIR` it uses for `groupFolder`, and the audio bytes already live at `GROUPS_DIR/<groupFolder>/attachments/raw/<file>` (the marker's relative path resolves against the group folder). A **channel-side `TranscriptionPreprocessor`** can therefore: parse the `[VoiceAttachment: …]` marker out of the prompt, read the audio file from local disk, POST it to the transcription capability, and substitute the returned text into the prompt — all before the LLM turn, **with no new inbound-media plumbing**. Audio-as-binary in `ContainerInput` is *not* required because the marker + on-disk file is the carrier.

> **Decision (D1):** SP3 implements transcription as a **channel-side, marker-driven content transform inside the preprocessor chain**, reading the audio file from the group PVC by the marker's path. It does **not** use the orchestrator-side `runPreprocessingJob` K8s-job path (which stays unwired/out of scope) and does **not** add an attachment field to `ContainerInput`. This keeps transcription on the same pre-LLM seam as RAG and reuses the existing marker the channels already emit.

## Decisions (resolving ambiguity)

- **(D1)** Channel-side, marker-driven transcription (above).
- **(D2) Chain interface returns both an LLM-facing prompt and an optional persisted-content override.** `apply(input) → { prompt, persistedContent? }`. Augmenters set `prompt` only (persisted content unchanged → SP2 contract preserved). Transforms set **both** `prompt` and `persistedContent` to the rewritten text. The runner threads `persistedContent` (when any transform produced one) into the existing `persistedUserContent` used for SQLite persistence (line ~1410) and RAG indexing (line ~1441), so the transcript — not the marker — is what gets stored and indexed.
- **(D3) Fixed order: transforms before augmenters.** The chain runs all content transforms first (producing the canonical user text), then all augmenters (against that canonical text). This guarantees RAG retrieves against the transcript, and that the augmented `<retrieved_context>` prefix is *not* persisted/indexed. Order within a phase is registration order; today that is transcription, then RAG.
- **(D4) Non-fatal per preprocessor.** Each preprocessor catches its own errors and, on failure, returns the input unchanged (`{ prompt: input.prompt }`). The chain never throws; a broken transcription capability degrades to "the marker stays in the prompt" and the LLM still answers. This matches the existing RAG provider contract (returns the original prompt on any failure).
- **(D5) `transcription` is a new capability kind, parallel to `rag`** — discovered via `getTranscriptionEntry(channel)`, config-on-spec, no secrets in discovery, normalize-on-read back-compat (vacuously true: no legacy transcription specs exist). A minimal provider config: request path + optional model; egress/streaming details deferred.
- **(D6) One transcription capability per channel.** Mirror SP2's `assertNoConflictingRag` guard: `getTranscriptionEntry` returns the first match, so more than one per channel silently orphans a pod. Reuse the same disjoint-ACL rule.
- **(D7) Audio transport to the capability: `multipart/form-data` POST with the raw file.** Whisper-class servers (faster-whisper / whisper.cpp HTTP wrappers, OpenAI-compatible `/v1/audio/transcriptions`) overwhelmingly accept multipart file upload. The provider config carries `transcribePath` (default `/v1/audio/transcriptions`), an optional `model`, an optional `responseField` (default `text`), and `timeoutMs`. Decided default endpoint mirrors the OpenAI audio API so a stock OpenAI-compatible whisper image installs as pure config.

## Design

### 1. Preprocessor framework — new `src/runtime/preprocessors/` (channel-side)

New module `src/runtime/preprocessors/types.ts`:

```ts
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
  /** MUST be non-throwing — return input unchanged on any failure. */
  apply(input: PreprocessorInput): Promise<PreprocessorResult>;
}
```

New `src/runtime/preprocessors/chain.ts`:

```ts
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
): Promise<ChainOutput>;
```

Behaviour (encodes D2–D4):
- Partition into `transforms` (effect `'transform'`) and `augmenters` (effect `'augment'`), preserving registration order within each.
- Run transforms sequentially, each on the running prompt. If a transform returns `persistedContent`, that becomes both the running prompt's basis and the running `persistedContent`. After all transforms, `persistedContent` is the canonical user text (defaults to the original prompt if no transform fired).
- Run augmenters sequentially on the running prompt; their `persistedContent` is ignored by contract (only transforms may set it; assert/log if an augmenter sets it).
- Each `apply` is wrapped so a throw or rejection is caught, logged at `warn`, and treated as a no-op for that stage (non-fatal).
- Return `{ prompt, persistedContent }`.

A `src/runtime/preprocessors/registry.ts` builds the default chain for a channel pod (registration order = transcription, then RAG):

```ts
export function buildDefaultPreprocessors(): InboundPreprocessor[] {
  return [new TranscriptionPreprocessor(), new RagPreprocessor()];
}
```

### 2. RAG as the first augmenter — `src/runtime/preprocessors/rag-preprocessor.ts`

A thin adapter over the existing `augmentPrompt` (unchanged in `src/rag/provider.ts`):

```ts
export class RagPreprocessor implements InboundPreprocessor {
  readonly name = 'rag';
  readonly effect = 'augment';
  async apply({ groupFolder, prompt }: PreprocessorInput): Promise<PreprocessorResult> {
    try {
      return { prompt: await augmentPrompt(groupFolder, prompt) };
    } catch {
      return { prompt };
    }
  }
}
```

This preserves RAG behaviour exactly: same `augmentPrompt` (same `<retrieved_context>` prefix, same non-fatal semantics), and because it is an augmenter its output never reaches `persistedContent` — identical to today's SP2 contract where the persisted/indexed text is the pre-augment prompt.

### 3. Transcription preprocessor — `src/runtime/preprocessors/transcription-preprocessor.ts`

A content transform driven by the `[VoiceAttachment: …]` marker:

- Scan `prompt` with `VOICE_ATTACHMENT_PATTERN` (`src/attachment-markers.ts`). No match → `{ prompt }` unchanged (fast path; zero cost when no voice present).
- Resolve the transcription capability via `getTranscriptionEntry(KUBECLAW_CHANNEL ?? '*')` (§5). No entry → leave the marker in place and return unchanged (non-fatal; the LLM at least sees that a voice note arrived).
- For each marked file: resolve `path.join(GROUPS_DIR, groupFolder, rawPath)` (same `GROUPS_DIR` the channel/runner already use; the marker path is relative and starts with `attachments/raw/`), read the bytes, POST as `multipart/form-data` to `endpoint + transcribePath` (with `model` if set), parse `responseField` (default `text`) from the JSON response.
- Replace each marker in the prompt with the transcript (decided rendering: `[Voice: <transcript>]`, matching the existing inline-voice convention documented in `src/types.ts:169`). The fully-substituted string is returned as **both** `prompt` and `persistedContent` (D2) — so the transcript is what gets stored and what RAG subsequently retrieves against.
- All I/O wrapped; any failure (missing file, non-2xx, timeout, bad JSON) logs `warn` and leaves that marker untouched (non-fatal).

A `src/transcription/client.ts` (parallel to the RAG provider) holds the HTTP/multipart logic, constructed from the discovery entry's `kindMetadata.provider` — no `process.env` reads for endpoint/config, mirroring SP2's provider construction.

### 4. Runner wiring — `src/runtime/direct-llm-runner.ts`

Replace the bespoke RAG block (lines ~1126-1136) with the chain:

```ts
const chain = this.preprocessors ?? buildDefaultPreprocessors();
const { prompt: augmentedPrompt, persistedContent } =
  await runPreprocessorChain(chain, input.groupFolder, input.prompt);
```

- `augmentedPrompt` feeds the live `messages` user turn (line ~1144) exactly as today.
- At persistence (line ~1410), the existing `stripContextHeader(input.prompt)` becomes `stripContextHeader(persistedContent)` so the transcript (not the marker) is persisted; when no transform fired, `persistedContent === input.prompt`, preserving today's behaviour byte-for-byte.
- RAG indexing (line ~1441) already uses `persistedUserContent`; it now indexes the transcript when voice was present — correct.
- The chain is injectable on the runner (constructor field `preprocessors?`) so tests can supply fakes; production defaults to `buildDefaultPreprocessors()`. The `KubernetesToolJobRunner` path (`src/runtime/index.ts`) is untouched (it is not the conversation path).

### 5. Transcription capability kind — `src/capabilities/`

Mirror SP2's RAG shapes:

- **`types.ts`**: add to the `CapabilitySpec` union:
  ```ts
  export interface TranscriptionProviderConfig {
    transcribePath?: string;   // default '/v1/audio/transcriptions'
    model?: string;            // optional; sent as multipart field when set
    responseField?: string;    // default 'text'
    timeoutMs?: number;        // default 60000 (Whisper-class can be slow)
  }
  export interface TranscriptionCapabilitySpec extends CapabilityBase {
    kind: 'transcription';
    provider?: TranscriptionProviderConfig;  // optional; defaults filled on read
  }
  ```
  Add a `transcription` member to `CapabilityDiscoveryEntry` with `kindMetadata: { provider: TranscriptionProviderConfig }` (no secrets — config only, matching SP2). Update `CapabilityKind`.
- **`transcription-config.ts`** (parallel to `rag-config.ts`): `DEFAULT_TRANSCRIPTION_CONFIG` and `normalizeTranscriptionSpec()` (fills provider defaults on read; vacuous back-compat since no legacy rows exist, but keeps the read path uniform).
- **`registry.ts`**: `defaultPort` gains a `transcription` case (decided default **9000**, the common faster-whisper-server port; specs may override via `port`). `specToDiscoveryEntry` gains a `transcription` case emitting the normalized provider. `assertNoConflictingRag` is generalized (or paralleled by `assertNoConflictingTranscription`) to enforce one-per-channel for transcription too (D6).
- **`client.ts`**: add `getTranscriptionEntry(channelName)` (exact parallel to `getRagEntry`).
- **`builders/index.ts`**: the `transcription` case calls the SP1/SP2 generic `renderDeploymentAndService` directly — **no per-impl builder** (D5 / SP2's generic-builder approach). Whisper-class images declare their own `probe` (likely `startup` for model warm-up), `scheduling`/`gpu`, and `endpointScheme` per SP1 — the builder needs no transcription-specific logic.
- **`channel-runner.ts`**: if a `backend`/adapter guard exists for non-recognized kinds, ensure `transcription` discovery entries are accepted and forwarded to the channel pod (they flow through `notifyAllChannels` → `capabilities_update` like any non-MCP entry; the channel-side preprocessor reads them via `getTranscriptionEntry`). The `resetRagProvider()`-on-`capabilities_update` hot-swap pattern is mirrored: a `resetTranscriptionProvider()` (or stateless client lookup) so a freshly installed transcription capability becomes active without a pod restart.

### 6. Install recipe & docs

Ship a documented **transcription capability install recipe** (spec JSON for the admin shell) using a stock OpenAI-compatible whisper image with `gpu`, a `startup` probe for model warm-up, and `endpointScheme: 'http'`. Update the capability/installation docs to list `transcription` alongside `rag`/`mcp`/`http`.

## Back-compat & migration

- **RAG behaviour is preserved exactly.** `augmentPrompt` is unchanged; RAG becomes an augmenter that runs after transforms. With no voice marker present, the chain output equals today's: `prompt = augmentPrompt(original)`, `persistedContent = original`. A regression snapshot pins this.
- **No `ContainerInput` shape change** (D1) — the marker + on-disk file is the carrier, so no inbound-media plumbing and no migration of callers.
- **No persisted-spec migration.** New `transcription` kind is additive; `normalizeTranscriptionSpec` fills defaults on read. Existing `mcp`/`http`/`rag` specs are untouched.
- **Unwired scaffold left alone.** `runPreprocessingJob` / the absent `attachment-preprocessor.js` stay out of scope (D1); SP3 neither wires nor deletes them.
- Channels with no `inboundVoice` support are unaffected (no voice markers ⇒ transcription preprocessor is a no-op fast path).

## Tests (three levels)

- **Unit:**
  - `runPreprocessorChain`: transforms run before augmenters; a transform's `persistedContent` propagates and is what augmenters retrieve against; an augmenter's `persistedContent` is ignored; a throwing preprocessor is skipped (non-fatal) and the chain still returns; empty chain is identity.
  - `RagPreprocessor`: delegates to a faked `augmentPrompt`; effect is `augment`; never sets `persistedContent`; non-fatal on throw. **Regression:** chain with only `RagPreprocessor` produces `{prompt: augmented, persistedContent: original}` — byte-identical to SP2's seam.
  - `TranscriptionPreprocessor`: no marker → identity fast path; marker + faked client → prompt and `persistedContent` both carry `[Voice: <transcript>]`; missing file / non-2xx / timeout → marker left intact, non-fatal; multiple markers handled; reads from `GROUPS_DIR/<groupFolder>/<rawPath>`.
  - Capability layer: `transcription` builder renders generic Deployment/Service (+ SP1 `startup`/`gpu`/`scheduling`); `normalizeTranscriptionSpec` defaults; `specToDiscoveryEntry`/`getTranscriptionEntry` round-trip with **no secrets** in the entry; `assertNoConflicting*` rejects a second universal transcription on the same channel.
- **Integration:**
  - `installCapability(transcriptionSpec)` → reconciler applies generic YAML → discovery round-trips `kindMetadata.provider`; `capabilities_update` delivers the entry; `getTranscriptionEntry` resolves it; the transcription client POSTs multipart to a faked HTTP server and returns text.
  - Chain end-to-end inside a `DirectLLMRunner` with injected fakes: a prompt containing `[VoiceAttachment: …]` is transcribed, RAG augments the transcript, the LLM turn sees `<retrieved_context> … [Voice: …]`, and persistence/indexing receive the transcript (assert via faked DB + faked RAG provider).
- **E2E (minikube; written, live run deferred per the unattended-cluster policy):** install a small whisper-class image **as a `transcription` capability** (SP1 `tcp`/`startup` probe to prove slow-warm reaches `Ready`), drop a short audio file into a group's `attachments/raw/`, send a turn whose prompt carries the voice marker, and assert the response reflects the transcribed content (transcription ran before the LLM turn end to end). A second e2e asserts RAG-only behaviour is unchanged when no voice is present.

## Non-goals (deferred)

- Adding a binary/audio attachment field to `ContainerInput` or any new inbound-media plumbing (D1 makes it unnecessary).
- Wiring or deleting the orchestrator-side `runPreprocessingJob` K8s-job path and writing `attachment-preprocessor.js` (separate concern; could become an SP4-style capability-composition path: image-resize / PDF-extract as preprocessors).
- Image and PDF preprocessors (the framework supports them as future `transform` preprocessors, but SP3 ships only RAG + transcription).
- Streaming/chunked or diarized transcription, language hints, and word timestamps (provider config is intentionally minimal; extend later).
- Routing transcription egress through the credential broker (in-cluster `.svc` traffic bypasses the broker per SP2's `workload-env` change; if a transcription capability needs an upstream API key it uses `envFromSecrets` like other capabilities).
- Outbound TTS / voice replies.

## File touchpoints (summary)

| File | Change |
| --- | --- |
| `src/runtime/preprocessors/types.ts` | **new** — `InboundPreprocessor`, effect types, in/out shapes |
| `src/runtime/preprocessors/chain.ts` | **new** — `runPreprocessorChain` (transform→augment, non-fatal) |
| `src/runtime/preprocessors/registry.ts` | **new** — `buildDefaultPreprocessors()` |
| `src/runtime/preprocessors/rag-preprocessor.ts` | **new** — RAG augmenter over `augmentPrompt` |
| `src/runtime/preprocessors/transcription-preprocessor.ts` | **new** — marker-driven content transform |
| `src/transcription/client.ts` | **new** — multipart POST client from discovery entry |
| `src/runtime/direct-llm-runner.ts` | edit — replace RAG block (~1126-1136) with chain; thread `persistedContent` into persist (~1410) + index (~1441); injectable `preprocessors` field |
| `src/capabilities/types.ts` | edit — `transcription` kind, `TranscriptionProviderConfig`, discovery entry member, `CapabilityKind` |
| `src/capabilities/transcription-config.ts` | **new** — defaults + `normalizeTranscriptionSpec` |
| `src/capabilities/registry.ts` | edit — `defaultPort`/`specToDiscoveryEntry`/conflict-guard for `transcription` |
| `src/capabilities/client.ts` | edit — `getTranscriptionEntry` |
| `src/capabilities/builders/index.ts` | edit — generic `transcription` case (no per-impl builder) |
| `src/channel-runner.ts` | edit — accept/forward `transcription` entries; reset on `capabilities_update` |
| `src/rag/provider.ts`, `src/attachment-markers.ts` | unchanged (reused) |
| docs | edit — transcription install recipe + capability list |
