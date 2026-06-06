# Story 179: Bootstrap Skill Registry Plan

## Overview

Admin-shell tools for listing, uploading, and removing bootstrap skills at runtime. Mirrors Story 178 (channel manifest registry) structurally.

## New SQLite Table

`bootstrap_skill_overrides(name TEXT PRIMARY KEY, markdown TEXT NOT NULL, content_hash TEXT NOT NULL, registered_at TEXT NOT NULL, registered_by TEXT NOT NULL)`

Added via `CREATE TABLE IF NOT EXISTS` in `src/db.ts:createSchema`.

## New Source Files

### `src/skills/orchestrator/bootstrap-skill-registry.ts`
- Mirrors `channel-manifest-registry.ts` structurally
- `registerBootstrapSkill(args, knownManifests, reconcile?)` — validates frontmatter via `parseBootstrapSkillFrontmatter`, computes sha256, upserts SQLite, calls reconcile
- `removeBootstrapSkill(name, baselineLoader, reconcile?)` — refuses helm-baseline names with `PROTECTED_BASELINE`, idempotent on missing admin entries
- `listBootstrapSkillOverrides()` — SELECT from `bootstrap_skill_overrides`
- Hash: `crypto.createHash('sha256').update(markdown, 'utf8').digest('hex')`

### `src/bootstrap-skills/reconciler.ts`
- `BootstrapSkillEntry` interface: `{name, channel_type, manifest_version, content_hash, source, registered_at, registered_by, markdown?}`
- `mergeSkills(baseline, overrides)` — admin wins on `name` collision, sorted by name
- `loadBaselineFromDisk(dir?)` — reads `/etc/kubeclaw/bootstrap-skills-baseline/` directory
- `BootstrapSkillReconciler` class with chained-apply pattern, targets `kubeclaw-bootstrap-skills` ConfigMap

### `src/runtime/skill-format.ts` extensions
- `BootstrapSkillFrontmatter` interface: `{name, description, bootstrap: {channelType, manifestVersion, expectedQuestions}}`
- `parseBootstrapSkillFrontmatter(raw, knownManifests)` — calls `parseSkill` for base fields, then layers bootstrap-specific extraction and cross-validation. Takes `{channelType, manifestVersion}[]` as injected dep — no K8s imports.

### `src/admin-shell.ts` extensions
- Three new tools after `register_channel_manifest`: `list_bootstrap_skills`, `register_bootstrap_skill`, `remove_bootstrap_skill`
- Handler functions using `bootstrapSkillReconciler` initialized at module top

### Helm
- `values.yaml`: add `bootstrap.skills: {}` comment block
- `helm/kubeclaw/templates/bootstrap-skills-configmap.yaml`: update to render `kubeclaw-bootstrap-skills-baseline` (from `bootstrap.skills` values map) + the empty live `kubeclaw-bootstrap-skills` ConfigMap

## Test Files

- `src/skills/orchestrator/bootstrap-skill-registry.test.ts` — unit
- `src/bootstrap-skills/reconciler.test.ts` — unit
- `src/runtime/skill-format.test.ts` — extended with `parseBootstrapSkillFrontmatter` cases

## AC Coverage

| AC | Where tested |
|----|-------------|
| 1 list merged view | reconciler.test + registry.test |
| 2 register with valid frontmatter | registry.test |
| 3 reject malformed frontmatter (6 rejection paths) | skill-format.test + registry.test |
| 4 idempotent on identical content | registry.test |
| 5 remove: admin→removed, repeat→already absent, baseline→PROTECTED_BASELINE | registry.test |
