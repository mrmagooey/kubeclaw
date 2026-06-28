# Dynamic Tool Selection — Phase 3: Open Discovery (Tier-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When tiers 1–2 miss, let the Tool Selection Agent discover a container image from an external registry, draft a runnable `ToolSpec` from its metadata, **probe-verify it in a locked-down sandbox**, and register it (group-scoped, provenance `discovered`) — but only on clusters with hard egress enforcement.

**Architecture:** Add a `searchRegistry` implementation injected into the Phase 1 TSA. It runs: registry search → LLM-drafted `ToolSpec` (preferring credential-free designs, with a derived `allowedEgress`) → sandboxed probe (a real one-shot sidecar tool job under the tightest egress + Phase 2 hardening, fed a synthetic smoke input, with off-allowlist egress treated as failure) → on success, register with `discovered` provenance scoped to the requesting group. The whole tier is hard-gated by `hasHardEgressEnforcement()` from Phase 2; without it, `searchRegistry` is never wired in and the TSA falls back to `unavailable`.

**Tech Stack:** TypeScript, Docker Hub registry HTTP API, OCI image labels, `@kubernetes/client-node`, the Phase 1 TSA + Phase 2 egress/probe infrastructure, Vitest.

## Global Constraints

- Tier-3 runs ONLY when `hasHardEgressEnforcement()` (Phase 2, `src/k8s/egress/substrate.ts`) is true. Orchestrator startup wires `searchRegistry` into the TSA deps conditionally on this flag; otherwise it is left `undefined`.
- Discovered images MUST be digest-pinned (`image@sha256:...`) in the registered `ToolSpec` — never a mutable tag.
- A drafted spec must pass `validateTool()` AND `checkEgressCredentialCoherence()` (Phase 2) before probing.
- Discovered tools register **group-scoped** (`channels`/group restriction = the requesting group only) with provenance `discovered`; global broadening is an explicit human action (out of scope here).
- Credential-bearing discovered tools still hit the Phase 1 in-channel credential gate; the probe runs WITHOUT credentials (credential-free smoke).
- Registry search and image-metadata fetch happen from the orchestrator (privileged), never from the channel.

---

## File Structure

| File | Responsibility | Create/Modify |
| ---- | -------------- | ------------- |
| `src/tool-selection/registry/search.ts` | Query Docker Hub for candidate images by keywords | Create |
| `src/tool-selection/registry/metadata.ts` | Fetch image manifest/labels + registry description; resolve digest | Create |
| `src/tool-selection/registry/draft.ts` | LLM-draft a `ToolSpec` (digest-pinned, `allowedEgress` derived) from metadata | Create |
| `src/tool-selection/probe/smoke-input.ts` | Build a synthetic smoke input for a drafted tool's params | Create |
| `src/tool-selection/probe/probe.ts` | Run the drafted tool as a one-shot sandbox job; verify result + no off-allowlist egress | Create |
| `src/tool-selection/discovery.ts` | Orchestrate search → draft → validate → probe → register (the `searchRegistry` impl) | Create |
| `src/tool-selection/agent.ts` | (Phase 1) consume `searchRegistry`; set `discovered` scope/provenance | Modify |
| `src/index.ts` | Conditionally wire `searchRegistry` into TSA deps when `hasHardEgressEnforcement()` | Modify |
| `src/k8s/job-runner.ts` | Add a `runProbeToolJob` path: one-shot, no credentials, tightest egress, captures egress violations | Modify |

---

## Task 1: Registry search

**Files:**
- Create: `src/tool-selection/registry/search.ts`
- Test: `src/tool-selection/registry/search.test.ts`

**Interfaces:**
- Consumes: an injected `fetchJson: (url: string) => Promise<unknown>` (so tests stub HTTP).
- Produces:
  - `interface ImageCandidate { repo: string; description: string; stars: number; official: boolean }`
  - `async function searchImages(keywords: string, fetchJson: FetchJson, limit?: number): Promise<ImageCandidate[]>` — queries `https://hub.docker.com/v2/search/repositories/?query=<kw>&page_size=<limit>`, maps results, sorts by (official desc, stars desc).

- [ ] **Step 1: Write the failing test**

```typescript
import { searchImages } from './search';

const fakeResponse = {
  results: [
    { repo_name: 'someuser/exiftool', short_description: 'exif', star_count: 5, is_official: false },
    { repo_name: 'library/alpine', short_description: 'tiny', star_count: 9000, is_official: true },
  ],
};

describe('searchImages', () => {
  it('maps and ranks official/starred images first', async () => {
    const fetchJson = async () => fakeResponse;
    const out = await searchImages('exiftool', fetchJson, 10);
    expect(out[0].repo).toBe('library/alpine'); // official ranks first
    expect(out[1].repo).toBe('someuser/exiftool');
  });

  it('returns [] on a malformed response', async () => {
    const fetchJson = async () => ({});
    expect(await searchImages('x', fetchJson)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/registry/search.test.ts`
Expected: FAIL — cannot find module `./search`.

- [ ] **Step 3: Implement**

```typescript
export type FetchJson = (url: string) => Promise<unknown>;

export interface ImageCandidate {
  repo: string;
  description: string;
  stars: number;
  official: boolean;
}

export async function searchImages(
  keywords: string,
  fetchJson: FetchJson,
  limit = 10,
): Promise<ImageCandidate[]> {
  const url = `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(keywords)}&page_size=${limit}`;
  let raw: unknown;
  try {
    raw = await fetchJson(url);
  } catch {
    return [];
  }
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const mapped: ImageCandidate[] = results
    .map((r) => {
      const o = r as Record<string, unknown>;
      if (typeof o.repo_name !== 'string') return null;
      return {
        repo: o.repo_name,
        description: typeof o.short_description === 'string' ? o.short_description : '',
        stars: typeof o.star_count === 'number' ? o.star_count : 0,
        official: o.is_official === true,
      };
    })
    .filter((x): x is ImageCandidate => x !== null);
  return mapped.sort((a, b) => Number(b.official) - Number(a.official) || b.stars - a.stars);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/registry/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-selection/registry/search.ts src/tool-selection/registry/search.test.ts
git commit -m "feat(discovery): Docker Hub image search with ranking"
```

---

## Task 2: Image metadata + digest resolution

**Files:**
- Create: `src/tool-selection/registry/metadata.ts`
- Test: `src/tool-selection/registry/metadata.test.ts`

**Interfaces:**
- Consumes: injected `fetchJson`.
- Produces:
  - `interface ImageMetadata { repo: string; digest: string | null; labels: Record<string, string>; readme: string }`
  - `async function fetchImageMetadata(repo: string, tag: string, fetchJson: FetchJson): Promise<ImageMetadata>` — fetches tag info (for the `digest`) and the repo description/full_description (readme) from Docker Hub; labels best-effort (empty if unavailable).

- [ ] **Step 1: Write the failing test**

```typescript
import { fetchImageMetadata } from './metadata';

describe('fetchImageMetadata', () => {
  it('extracts digest and readme', async () => {
    const fetchJson = async (url: string) => {
      if (url.includes('/tags/')) return { images: [{ digest: 'sha256:abc123' }] };
      return { full_description: 'Use exiftool to read EXIF.' };
    };
    const md = await fetchImageMetadata('someuser/exiftool', 'latest', fetchJson);
    expect(md.digest).toBe('sha256:abc123');
    expect(md.readme).toContain('EXIF');
  });

  it('tolerates missing digest', async () => {
    const fetchJson = async () => ({});
    const md = await fetchImageMetadata('x/y', 'latest', fetchJson);
    expect(md.digest).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/registry/metadata.test.ts`
Expected: FAIL — cannot find module `./metadata`.

- [ ] **Step 3: Implement**

```typescript
import type { FetchJson } from './search';

export interface ImageMetadata {
  repo: string;
  digest: string | null;
  labels: Record<string, string>;
  readme: string;
}

export async function fetchImageMetadata(
  repo: string,
  tag: string,
  fetchJson: FetchJson,
): Promise<ImageMetadata> {
  let digest: string | null = null;
  let readme = '';
  try {
    const tagInfo = (await fetchJson(`https://hub.docker.com/v2/repositories/${repo}/tags/${tag}`)) as {
      images?: { digest?: string }[];
    };
    digest = tagInfo.images?.[0]?.digest ?? null;
  } catch {
    /* tolerate */
  }
  try {
    const repoInfo = (await fetchJson(`https://hub.docker.com/v2/repositories/${repo}`)) as {
      full_description?: string;
      description?: string;
    };
    readme = repoInfo.full_description ?? repoInfo.description ?? '';
  } catch {
    /* tolerate */
  }
  return { repo, digest, labels: {}, readme };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/registry/metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-selection/registry/metadata.ts src/tool-selection/registry/metadata.test.ts
git commit -m "feat(discovery): image metadata + digest resolution"
```

---

## Task 3: LLM ToolSpec draft

**Files:**
- Create: `src/tool-selection/registry/draft.ts`
- Test: `src/tool-selection/registry/draft.test.ts`

**Interfaces:**
- Consumes: `ChatFn` (Phase 1 `src/tool-selection/matcher.ts`); `ImageMetadata` (Task 2); `validateTool` (`src/tools/types.ts`).
- Produces:
  - `async function draftToolSpec(args: { taskDescription: string; metadata: ImageMetadata; chat: ChatFn }): Promise<{ ok: true; spec: ToolSpec } | { ok: false; error: string }>` — prompts the LLM for STRICT JSON `ToolSpec`, forces `image` to `repo@digest` (rejects if no digest), prefers `pattern: file` / credential-free, then runs `validateTool`. Strips any disallowed fields by re-validating.

- [ ] **Step 1: Write the failing test**

```typescript
import { draftToolSpec } from './draft';

const md = { repo: 'someuser/exiftool', digest: 'sha256:abc', labels: {}, readme: 'exiftool reads EXIF' };

describe('draftToolSpec', () => {
  it('produces a digest-pinned, valid spec', async () => {
    const chat = async () =>
      JSON.stringify({
        name: 'extract_metadata', description: 'Extract EXIF metadata',
        parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
        image: 'someuser/exiftool:latest', pattern: 'file', mount: 'group',
        run: 'exiftool "$(cat "$INPUT_DIR/filename")"',
      });
    const r = await draftToolSpec({ taskDescription: 'exif', metadata: md, chat });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.image).toBe('someuser/exiftool@sha256:abc'); // pinned to digest
  });

  it('fails when no digest is available', async () => {
    const chat = async () => JSON.stringify({ name: 'x', description: 'd', parameters: { type: 'object' }, image: 'x:latest', pattern: 'file' });
    const r = await draftToolSpec({ taskDescription: 't', metadata: { ...md, digest: null }, chat });
    expect(r.ok).toBe(false);
  });

  it('fails when the draft is not a valid ToolSpec', async () => {
    const chat = async () => JSON.stringify({ name: 'BAD NAME!!', description: 'd', parameters: {}, image: 'x', pattern: 'nope' });
    const r = await draftToolSpec({ taskDescription: 't', metadata: md, chat });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/registry/draft.test.ts`
Expected: FAIL — cannot find module `./draft`.

- [ ] **Step 3: Implement**

```typescript
import type { ToolSpec } from '../../tools/types';
import { validateTool } from '../../tools/types';
import type { ChatFn } from '../matcher';
import type { ImageMetadata } from './metadata';

export async function draftToolSpec(args: {
  taskDescription: string;
  metadata: ImageMetadata;
  chat: ChatFn;
}): Promise<{ ok: true; spec: ToolSpec } | { ok: false; error: string }> {
  if (!args.metadata.digest) {
    return { ok: false, error: 'image has no resolvable digest; refusing to draft a mutable-tag tool' };
  }

  const system =
    'You convert a container image into a KubeClaw ToolSpec. Respond with STRICT JSON only. ' +
    'Fields: name (snake_case), description, parameters (JSON Schema object), image, pattern ' +
    '("file"|"http"|"acp"|"cdp"), optional run (file pattern shell template using ' +
    '"$(cat \\"$INPUT_DIR/<param>\\")"), mount ("none"|"scratch"|"group"), allowedEgress ' +
    '([{host,ports}]). PREFER pattern "file" and NO credentials. Only include allowedEgress hosts ' +
    'the tool genuinely needs; an offline tool (e.g. metadata extraction) MUST use allowedEgress: [].';
  const user =
    `Task: ${args.taskDescription}\nImage: ${args.metadata.repo}\nReadme:\n${args.metadata.readme.slice(0, 4000)}`;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await args.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ])) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'unparseable draft' };
  }

  // Force digest pinning regardless of what the LLM wrote.
  parsed.image = `${args.metadata.repo}@${args.metadata.digest}`;

  const v = validateTool(parsed);
  if (!v.ok) return { ok: false, error: `drafted spec invalid: ${v.error}` };
  return { ok: true, spec: parsed as unknown as ToolSpec };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/registry/draft.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-selection/registry/draft.ts src/tool-selection/registry/draft.test.ts
git commit -m "feat(discovery): LLM ToolSpec draft with forced digest pinning"
```

---

## Task 4: Smoke-input synthesis

**Files:**
- Create: `src/tool-selection/probe/smoke-input.ts`
- Test: `src/tool-selection/probe/smoke-input.test.ts`

**Interfaces:**
- Produces:
  - `function buildSmokeInput(parameters: Record<string, unknown>): Record<string, string>` — for each required (then optional) property in the JSON-Schema `parameters`, produce a benign value by type (string→"smoke-test", number→"1", boolean→"true"); returns a flat string map suitable for the file/http bridge.

- [ ] **Step 1: Write the failing test**

```typescript
import { buildSmokeInput } from './smoke-input';

describe('buildSmokeInput', () => {
  it('fills required params with type-appropriate benign values', () => {
    const params = {
      type: 'object',
      properties: { filename: { type: 'string' }, count: { type: 'number' }, flag: { type: 'boolean' } },
      required: ['filename', 'count'],
    };
    const input = buildSmokeInput(params);
    expect(input.filename).toBe('smoke-test');
    expect(input.count).toBe('1');
  });

  it('returns an empty object when there are no properties', () => {
    expect(buildSmokeInput({ type: 'object' })).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/probe/smoke-input.test.ts`
Expected: FAIL — cannot find module `./smoke-input`.

- [ ] **Step 3: Implement**

```typescript
export function buildSmokeInput(parameters: Record<string, unknown>): Record<string, string> {
  const props = (parameters.properties as Record<string, { type?: string }> | undefined) ?? {};
  const out: Record<string, string> = {};
  for (const [name, schema] of Object.entries(props)) {
    switch (schema.type) {
      case 'number':
      case 'integer':
        out[name] = '1';
        break;
      case 'boolean':
        out[name] = 'true';
        break;
      default:
        out[name] = 'smoke-test';
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/probe/smoke-input.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-selection/probe/smoke-input.ts src/tool-selection/probe/smoke-input.test.ts
git commit -m "feat(discovery): smoke-input synthesis for probes"
```

---

## Task 5: Probe runner (job-runner seam + orchestration)

**Files:**
- Modify: `src/k8s/job-runner.ts` (add `runProbeToolJob`)
- Create: `src/tool-selection/probe/probe.ts`
- Test: `src/tool-selection/probe/probe.test.ts`

**Interfaces:**
- Consumes: `buildSmokeInput` (Task 4); a `ProbeJobRunner` seam: `runProbeToolJob(args: { toolSpec: ToolSpec; input: Record<string, string>; timeoutMs: number }): Promise<{ ok: boolean; output?: string; egressViolation?: boolean; error?: string }>`. The job runs one-shot, NO credentials injected, with the tightest egress (only the spec's `allowedEgress`, default-deny otherwise) and Phase 2 hardening. An off-allowlist egress attempt (denied connection observable, or, minimally, a hard-substrate denial) is reported as `egressViolation`.
- Produces:
  - `interface ProbeResult { verified: boolean; reason: string }`
  - `async function probeTool(spec: ToolSpec, runner: ProbeJobRunner): Promise<ProbeResult>` — builds smoke input, runs the probe job, returns `verified` iff the job completed with a well-formed (non-error, non-empty) result and no egress violation.

- [ ] **Step 1: Write the failing test** (stub `ProbeJobRunner`)

```typescript
import { probeTool, type ProbeJobRunner } from './probe';
import type { ToolSpec } from '../../tools/types';

const spec: ToolSpec = {
  name: 'extract_metadata', description: 'd',
  parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
  image: 'r@sha256:abc', pattern: 'file', mount: 'scratch', allowedEgress: [],
};

describe('probeTool', () => {
  it('verifies a tool whose probe returns a well-formed result', async () => {
    const runner: ProbeJobRunner = { runProbeToolJob: async () => ({ ok: true, output: 'ExifTool Version Number: 12.0' }) };
    const r = await probeTool(spec, runner);
    expect(r.verified).toBe(true);
  });

  it('fails a tool whose probe attempts off-allowlist egress', async () => {
    const runner: ProbeJobRunner = { runProbeToolJob: async () => ({ ok: false, egressViolation: true }) };
    const r = await probeTool(spec, runner);
    expect(r.verified).toBe(false);
    expect(r.reason).toContain('egress');
  });

  it('fails a tool whose probe errors or returns nothing', async () => {
    const runner: ProbeJobRunner = { runProbeToolJob: async () => ({ ok: false, error: 'crash' }) };
    expect((await probeTool(spec, runner)).verified).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/probe/probe.test.ts`
Expected: FAIL — cannot find module `./probe`.

- [ ] **Step 3: Implement `probe.ts`**

```typescript
import type { ToolSpec } from '../../tools/types';
import { buildSmokeInput } from './smoke-input';

export interface ProbeJobRunner {
  runProbeToolJob(args: {
    toolSpec: ToolSpec;
    input: Record<string, string>;
    timeoutMs: number;
  }): Promise<{ ok: boolean; output?: string; egressViolation?: boolean; error?: string }>;
}

export interface ProbeResult {
  verified: boolean;
  reason: string;
}

const PROBE_TIMEOUT_MS = 60_000;

export async function probeTool(spec: ToolSpec, runner: ProbeJobRunner): Promise<ProbeResult> {
  // Probe a credential-FREE copy of the spec: never inject secrets during a smoke test.
  const probeSpec: ToolSpec = { ...spec, credentials: undefined };
  const input = buildSmokeInput(spec.parameters as Record<string, unknown>);
  const res = await runner.runProbeToolJob({ toolSpec: probeSpec, input, timeoutMs: PROBE_TIMEOUT_MS });

  if (res.egressViolation) return { verified: false, reason: 'probe attempted off-allowlist egress' };
  if (!res.ok) return { verified: false, reason: `probe failed: ${res.error ?? 'unknown error'}` };
  if (!res.output || res.output.trim().length === 0) return { verified: false, reason: 'probe returned empty output' };
  return { verified: true, reason: 'probe produced a well-formed result' };
}
```

- [ ] **Step 4: Implement the `runProbeToolJob` seam** in `src/k8s/job-runner.ts` — a thin variant of `createSidecarToolPodJob` that: forces no credential sidecar; applies the Phase 2 hardened securityContext; applies a per-pod egress policy from `probeSpec.allowedEgress` (default-deny); injects the smoke input via the existing file/http bridge; waits for completion; maps a denied-connection signal (best-effort: non-zero tool exit combined with the hard substrate's deny, or a sentinel the bridge surfaces) to `egressViolation`. Reuse the existing job plumbing — do not duplicate it.

- [ ] **Step 5: Run unit test + build**

Run: `npx vitest run src/tool-selection/probe/probe.test.ts && npm run build`
Expected: PASS and clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/tool-selection/probe/probe.ts src/k8s/job-runner.ts src/tool-selection/probe/smoke-input.ts src/tool-selection/probe/probe.test.ts
git commit -m "feat(discovery): sandboxed probe runner (credential-free, default-deny egress)"
```

---

## Task 6: Discovery orchestration (`searchRegistry`)

**Files:**
- Create: `src/tool-selection/discovery.ts`
- Test: `src/tool-selection/discovery.test.ts`

**Interfaces:**
- Consumes: `searchImages` (Task 1), `fetchImageMetadata` (Task 2), `draftToolSpec` (Task 3), `probeTool` (Task 5), `checkEgressCredentialCoherence` (Phase 2).
- Produces:
  - `interface DiscoveryDeps { fetchJson: FetchJson; chat: ChatFn; probe: ProbeJobRunner; catalogHostLookup: (id: string) => string | undefined; maxCandidates?: number }`
  - `function makeSearchRegistry(deps: DiscoveryDeps): (taskDescription: string) => Promise<ToolSpec | null>` — search top-N candidates; for each: fetch metadata → draft → coherence check → probe; return the first that verifies (with `allowedEgress` and digest set). Returns `null` if none verify. Does NOT register (the TSA registers, applying scope/provenance) — keeps discovery pure and testable.

- [ ] **Step 1: Write the failing test**

```typescript
import { makeSearchRegistry } from './discovery';

const exifDraft = {
  name: 'extract_metadata', description: 'EXIF',
  parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
  image: 'someuser/exiftool:latest', pattern: 'file', mount: 'group',
  run: 'exiftool "$(cat "$INPUT_DIR/filename")"',
};

describe('makeSearchRegistry', () => {
  it('returns the first candidate that drafts coherently and probes clean', async () => {
    const search = makeSearchRegistry({
      fetchJson: async (url) => {
        if (url.includes('/search/')) return { results: [{ repo_name: 'someuser/exiftool', star_count: 5, is_official: false }] };
        if (url.includes('/tags/')) return { images: [{ digest: 'sha256:abc' }] };
        return { full_description: 'exiftool' };
      },
      chat: async () => JSON.stringify(exifDraft),
      probe: { runProbeToolJob: async () => ({ ok: true, output: 'ExifTool 12' }) },
      catalogHostLookup: () => undefined,
    });
    const spec = await search('extract exif metadata from an image');
    expect(spec?.name).toBe('extract_metadata');
    expect(spec?.image).toBe('someuser/exiftool@sha256:abc');
  });

  it('returns null when every candidate fails the probe', async () => {
    const search = makeSearchRegistry({
      fetchJson: async (url) => {
        if (url.includes('/search/')) return { results: [{ repo_name: 'x/y', star_count: 1, is_official: false }] };
        if (url.includes('/tags/')) return { images: [{ digest: 'sha256:zzz' }] };
        return { full_description: 'thing' };
      },
      chat: async () => JSON.stringify({ ...exifDraft, image: 'x/y:latest' }),
      probe: { runProbeToolJob: async () => ({ ok: false, egressViolation: true }) },
      catalogHostLookup: () => undefined,
    });
    expect(await search('do a thing')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/discovery.test.ts`
Expected: FAIL — cannot find module `./discovery`.

- [ ] **Step 3: Implement**

```typescript
import type { ToolSpec } from '../tools/types';
import type { FetchJson } from './registry/search';
import { searchImages } from './registry/search';
import { fetchImageMetadata } from './registry/metadata';
import { draftToolSpec } from './registry/draft';
import { probeTool, type ProbeJobRunner } from './probe/probe';
import { checkEgressCredentialCoherence } from '../k8s/egress/coherence';
import type { ChatFn } from './matcher';
import { logger } from '../logger';

export interface DiscoveryDeps {
  fetchJson: FetchJson;
  chat: ChatFn;
  probe: ProbeJobRunner;
  catalogHostLookup: (id: string) => string | undefined;
  maxCandidates?: number;
}

export function makeSearchRegistry(
  deps: DiscoveryDeps,
): (taskDescription: string) => Promise<ToolSpec | null> {
  return async (taskDescription: string) => {
    const candidates = await searchImages(taskDescription, deps.fetchJson, deps.maxCandidates ?? 5);
    for (const c of candidates) {
      try {
        const md = await fetchImageMetadata(c.repo, 'latest', deps.fetchJson);
        const drafted = await draftToolSpec({ taskDescription, metadata: md, chat: deps.chat });
        if (!drafted.ok) {
          logger.debug({ repo: c.repo, error: drafted.error }, 'draft rejected; next candidate');
          continue;
        }
        const coherence = checkEgressCredentialCoherence(drafted.spec, deps.catalogHostLookup);
        if (!coherence.ok) {
          logger.debug({ repo: c.repo, error: coherence.error }, 'incoherent egress/credentials; next candidate');
          continue;
        }
        const verdict = await probeTool(drafted.spec, deps.probe);
        if (verdict.verified) return drafted.spec;
        logger.debug({ repo: c.repo, reason: verdict.reason }, 'probe failed; next candidate');
      } catch (err) {
        logger.warn({ repo: c.repo, err }, 'candidate evaluation error; next candidate');
      }
    }
    return null;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-selection/discovery.ts src/tool-selection/discovery.test.ts
git commit -m "feat(discovery): search→draft→coherence→probe orchestration"
```

---

## Task 7: TSA registers discovered tools group-scoped with provenance

**Files:**
- Modify: `src/tool-selection/agent.ts` (the tier-3 branch from Phase 1)
- Test: `src/tool-selection/agent.test.ts` (add discovered-scope cases)

**Interfaces:**
- Consumes: `searchRegistry` (Task 6 via `TsaDeps.searchRegistry`); `registerTool` with the Phase 2 `catalogHostLookup` arg; `recordAutoTool`.
- Behavior change: when `searchRegistry` returns a spec, the TSA (a) sets `channels: [req.channel]`-equivalent group scoping — set the discovered tool's visibility to the requesting group by writing the group restriction the codebase uses for per-group tools (use `channels` scoped to `req.channel`; if group-level scoping differs, follow the existing per-group tool convention), (b) evaluates the credential gate (a credentialed discovered tool returns `pending_credential` exactly like tier-2), (c) on credential-free, `registerTool(spec, reconcile, catalogHostLookup)` and `recordAutoTool({ provenance: 'discovered', scopeGroup: req.groupFolder, sourceDigest: <from image>, transcript: ... })`.

- [ ] **Step 1: Write the failing test (append to agent.test.ts)**

```typescript
import { getAutoTool } from './provenance';

describe('runToolSelection tier-3', () => {
  beforeEach(() => resetDbForTest());

  it('registers a discovered credential-free tool group-scoped with provenance=discovered', async () => {
    const discovered = {
      name: 'extract_metadata', description: 'EXIF', parameters: {}, image: 'r@sha256:abc',
      pattern: 'file', mount: 'group', allowedEgress: [],
    };
    const r = await runToolSelection(
      { requestId: 'r', groupFolder: 'team-a', channel: 'http', taskDescription: 'exif' },
      deps({
        liveCatalog: () => [],
        library: () => [],
        chat: async () => JSON.stringify({ name: null, confidence: 0, reason: 'no' }),
        searchRegistry: async () => discovered as any,
      }),
    );
    expect(r.status).toBe('ready');
    const meta = getAutoTool('extract_metadata');
    expect(meta?.provenance).toBe('discovered');
    expect(meta?.scopeGroup).toBe('team-a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/agent.test.ts -t 'tier-3'`
Expected: FAIL — current tier-3 branch returns `ready` without registering/scoping.

- [ ] **Step 3: Implement** — replace the Phase 1 placeholder tier-3 branch in `runToolSelection`:

```typescript
if (deps.searchRegistry) {
  try {
    const discovered = await deps.searchRegistry(req.taskDescription);
    if (discovered) {
      const scoped: ToolSpec = { ...discovered, channels: [req.channel] };
      const gate = evaluateGate(scoped, deps.catalogHostLookup);
      if (gate.needsApproval) {
        const token = mintApprovalToken(scoped.name, gate.catalogId!, deps.nonce);
        return {
          status: 'pending_credential',
          toolName: scoped.name, catalogId: gate.catalogId!, host: gate.host ?? '(unknown host)',
          approvalToken: token,
          message: `Discovered tool ${scoped.name} needs your ${gate.catalogId} credential. Approve to enable it.`,
        };
      }
      const reg = registerTool(scoped, deps.reconcile, deps.catalogHostLookup);
      if (!reg.ok) return { status: 'unavailable', message: `Could not register discovered ${scoped.name}: ${reg.error}` };
      recordAutoTool({
        name: scoped.name, provenance: 'discovered', scopeGroup: req.groupFolder,
        sourceDigest: scoped.image.split('@')[1] ?? null, now: deps.now(),
      });
      return { status: 'ready', tools: [candidate(scoped, 'discovered')], message: `Discovered and enabled ${scoped.name} (this group only).` };
    }
  } catch (err) {
    logger.warn({ err, requestId: req.requestId }, 'registry discovery failed');
  }
}
```

> The credential-approval finalizer (Phase 1 Task 8) must also re-scope discovered tools. When the approval is for a discovered tool, register with `channels: [channel]` and `recordAutoTool({ provenance: 'discovered', scopeGroup })`. Thread the `channel`/`groupFolder` and a `provenance` hint through the approval message fields so the finalizer knows. Add a unit test mirroring the tier-2 finalizer test for the discovered case.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tool-selection/agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-selection/agent.ts src/tool-selection/agent.test.ts
git commit -m "feat(discovery): register discovered tools group-scoped with provenance"
```

---

## Task 8: Hard-gate wiring at orchestrator startup

**Files:**
- Modify: `src/index.ts` (conditionally build + inject `searchRegistry`)
- Create: `src/tool-selection/discovery-gate.test.ts`

**Interfaces:**
- Consumes: `hasHardEgressEnforcement` (Phase 2 Task 4); `makeSearchRegistry` (Task 6). The find-tools watcher deps gain `searchRegistry?: ...`; it is set ONLY when `hasHardEgressEnforcement()` is true.

- [ ] **Step 1: Write the failing test** — factor the deps assembly into a pure `buildTsaSearchRegistry(env, factoryDeps)` returning `undefined` when enforcement is absent:

```typescript
import { buildTsaSearchRegistry } from './discovery';

describe('discovery hard-gate', () => {
  const factoryDeps = { fetchJson: async () => ({}), chat: async () => '', probe: { runProbeToolJob: async () => ({ ok: true }) }, catalogHostLookup: () => undefined };

  it('returns a search function when hard egress enforcement is present', () => {
    expect(typeof buildTsaSearchRegistry({ CILIUM_NETWORK_POLICY_ENABLED: 'true' }, factoryDeps)).toBe('function');
  });

  it('returns undefined (tier-3 disabled) without hard enforcement', () => {
    expect(buildTsaSearchRegistry({ CREDENTIAL_INJECTION_MODE: 'sidecar' }, factoryDeps)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tool-selection/discovery-gate.test.ts`
Expected: FAIL — `buildTsaSearchRegistry is not a function`.

- [ ] **Step 3: Implement `buildTsaSearchRegistry`** in `src/tool-selection/discovery.ts`:

```typescript
import { hasHardEgressEnforcement } from '../k8s/egress/substrate';

export function buildTsaSearchRegistry(
  env: NodeJS.ProcessEnv,
  deps: DiscoveryDeps,
): ((taskDescription: string) => Promise<ToolSpec | null>) | undefined {
  if (!hasHardEgressEnforcement(env)) return undefined;
  return makeSearchRegistry(deps);
}
```

- [ ] **Step 4: Wire into `src/index.ts`** — in the `startFindToolsWatcher({...})` deps (Phase 1 Task 9), add:

```typescript
searchRegistry: buildTsaSearchRegistry(process.env, {
  fetchJson: makeHttpJsonFetcher(),          // small wrapper over fetch with a timeout
  chat: makeOrchestratorChatFn(),
  probe: { runProbeToolJob: (a) => jobRunner.runProbeToolJob(a) },
  catalogHostLookup: (id) => brokerCatalog.find((e) => e.id === id)?.host,
}),
```

And pass `searchRegistry` from the watcher deps into the `runToolSelection` `TsaDeps` inside `handleFindToolsMessage` (extend `FindToolsHandlerDeps` with an optional `searchRegistry`).

- [ ] **Step 5: Run test + build**

Run: `npx vitest run src/tool-selection/discovery-gate.test.ts && npm run build`
Expected: PASS and clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/tool-selection/discovery.ts src/k8s/ipc-redis.ts src/tool-selection/discovery-gate.test.ts
git commit -m "feat(discovery): hard-gate tier-3 on egress enforcement at startup"
```

---

## Task 9: Integration test — discovery falls back when gate is closed

**Files:**
- Create: `src/tool-selection/discovery-integration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { runToolSelection, type TsaDeps } from './agent';
import { buildTsaSearchRegistry } from './discovery';
import { resetDbForTest } from '../db';

describe('discovery integration', () => {
  beforeEach(() => resetDbForTest());

  it('without hard enforcement, tier-3 is skipped and result is unavailable', async () => {
    const searchRegistry = buildTsaSearchRegistry(
      { CREDENTIAL_INJECTION_MODE: 'sidecar' },
      { fetchJson: async () => ({ results: [{ repo_name: 'x/y', star_count: 1 }] }), chat: async () => '{}', probe: { runProbeToolJob: async () => ({ ok: true, output: 'x' }) }, catalogHostLookup: () => undefined },
    );
    const deps: TsaDeps = {
      chat: async () => JSON.stringify({ name: null, confidence: 0, reason: 'no' }),
      liveCatalog: () => [], library: () => [], catalogHostLookup: () => undefined,
      reconcile: async () => {}, now: () => 1, nonce: 'n', searchRegistry,
    };
    const r = await runToolSelection({ requestId: 'r', groupFolder: 'g', channel: 'http', taskDescription: 'anything' }, deps);
    expect(r.status).toBe('unavailable'); // searchRegistry is undefined → fallback
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/tool-selection/discovery-integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tool-selection/discovery-integration.test.ts
git commit -m "test(discovery): tier-3 disabled without hard egress enforcement"
```

---

## Task 10: E2E — discovery path (CI / hard-substrate cluster)

**Files:**
- Create/extend: the repo's e2e suite

- [ ] **Step 1: Write the e2e** — on a minikube with Cilium (or Istio) enabled, with tiers 1–2 forced empty (point the library at an empty ConfigMap):
  1. User asks for a capability only satisfiable by discovery (e.g. a niche, credential-free file transform).
  2. `find_tools(...)` triggers discovery → draft → probe → register.
  3. Assert: the registered tool's image is digest-pinned; its provenance is `discovered`; it is visible ONLY to the requesting group (a second group's `find_tools` for the same need must re-discover or report unavailable, not silently reuse); a per-pod egress policy exists matching the drafted `allowedEgress`.
  4. Negative: a candidate image that phones home to an off-allowlist host is rejected by the probe (seed a known-bad image fixture).

- [ ] **Step 2: Run it** (CI / 8Gi minikube with hard egress substrate — NOT the dev host)

Run: `npm run test:e2e -- --grep 'tool discovery'`
Expected: PASS on CI.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/
git commit -m "test(e2e): tier-3 discovery path with probe rejection + group scoping"
```

> **Completion report must state** whether the e2e ran on CI/hard-substrate minikube or was only authored. Do not claim e2e pass without the run output.

---

## Task 11: Docs

**Files:**
- Modify: `docs/TOOL_BRIDGE.md` (note discovered tools + digest pinning + probe) and `CLAUDE.md` Key Files table (add `src/tool-selection/`)
- Create: `docs/DYNAMIC_TOOL_SELECTION.md` (operator-facing: tiers, the credential gate UX, the tier-3 hard-gate requirement, TTL/provenance, how to promote a discovered tool to global)

- [ ] **Step 1: Write `docs/DYNAMIC_TOOL_SELECTION.md`** covering: the three tiers; `find_tools`/`approve_tool_credential` UX; that tier-3 requires Cilium or Istio; provenance + TTL; group-scoping of discovered tools and the manual global-promotion step; security model (probe sandbox, default-deny egress, no-credential probe, digest pinning).

- [ ] **Step 2: Update `CLAUDE.md`** Key Files table with a `src/tool-selection/` row.

- [ ] **Step 3: Commit**

```bash
git add docs/DYNAMIC_TOOL_SELECTION.md docs/TOOL_BRIDGE.md CLAUDE.md
git commit -m "docs: document dynamic tool selection (tiers, gate, discovery, security)"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** registry search/metadata/draft (Tasks 1–3), digest pinning (Task 3), smoke probe with default-deny egress + no-credential probe (Tasks 4–5), search→draft→coherence→probe orchestration (Task 6), discovered tools group-scoped + provenance `discovered` (Task 7), hard-gate on egress enforcement (Task 8), fallback when gate closed (Task 9), discovery e2e incl. probe rejection + group scoping (Task 10), docs incl. manual global promotion (Task 11).
- **Type consistency:** `FetchJson`, `ImageCandidate`, `ImageMetadata`, `ProbeJobRunner`, `ProbeResult`, `DiscoveryDeps` each defined once; `draftToolSpec`/`probeTool`/`makeSearchRegistry`/`buildTsaSearchRegistry` signatures are consistent across tasks; reuses Phase 1 `ChatFn`, `TsaDeps.searchRegistry`, `registerTool(spec, reconcile, catalogHostLookup)` (Phase 2 signature) and `recordAutoTool` exactly.
- **Placeholders:** none — code complete. The `runProbeToolJob` job-runner seam (Task 5 Step 4) and e2e harness invocations are described as reuse of existing plumbing, not deferred stubs.
- **Cross-phase dependency:** requires Phase 1 (TSA, gate, provenance, find_tools) and Phase 2 (`allowedEgress`, coherence, substrate detection, hardened probe pods, `hasHardEgressEnforcement`). Stated in the header.
```

---

## Deferred follow-ups

1. **[#3] Apply the tool-job egress NetworkPolicy BEFORE pod creation** — currently `createSidecarToolPodJob` creates the Job then applies the policy via `egressApplier.applyForJob`, leaving a brief unrestricted-egress window before Cilium/Istio enforcement lands. This is a pre-existing race for ALL tool jobs, but the impact is higher for unvetted discovery probe images. The fix requires restructuring `createSidecarToolPodJob` to apply the policy first (or atomically), then submit the Job — which touches shared job-runner plumbing and ownerRef garbage-collection semantics. Deferred to a dedicated fix so it can be reviewed and tested independently (`src/k8s/job-runner.ts`, `createSidecarToolPodJob` / `buildSidecarToolPodManifest`).

2. **[Task 10] Tier-3 e2e authored but not run** — the e2e test in `e2e/dynamic-tool-selection-discovery.test.ts` requires a live 8 Gi minikube cluster with Cilium network policy enforcement enabled. This environment is not available in the standard CI runner for this project (9.5 Gi host, no free headroom). The test is a placeholder/skeleton that documents the expected flow; it must be run on a CI environment or dedicated larger host before the tier-3 discovery feature can be considered fully verified end-to-end.
