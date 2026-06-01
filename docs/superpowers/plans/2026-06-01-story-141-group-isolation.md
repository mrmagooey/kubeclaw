# Story 141: Group state isolation — state writes scoped per-group never leak

## Goal

Verify that group A's Redis state writes are completely invisible to group B, confirming the key-prefix scheme in `src/k8s/ipc-redis.ts` provides correct namespace isolation so no cross-group data leakage is possible via Redis key collisions.

## Architecture

All group state is keyed using a `<NAMESPACE>:group:<groupFolder>:` prefix (or equivalent typed variants such as `:data:`, `:activity:`, `:session:`). The namespace segment (`NAMESPACE`) is derived from the test harness via `getNamespace()` in `e2e/setup.ts`, and the group segment is the per-user `group_folder` value (e.g. `http-http-alice`). Because keys are fully qualified with the group folder in the path, two distinct groups writing the same logical key name cannot collide — they land in entirely separate Redis key-spaces.

The tests operate directly against a live Redis instance via `getSharedRedis()`, bypassing the orchestrator layer to validate the raw key-prefix contract rather than any higher-level API. Two distinct `testGroup` / `testGroup2` strings are allocated in `beforeAll`, ensuring tests run against real divergent prefixes.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e -- state-persistence -t "Group State Isolation"`)
- **Redis client:** ioredis — `getSharedRedis()` from `e2e/setup.ts`
- **Key-prefix implementation:** `src/k8s/ipc-redis.ts`
- **LLM dependence:** none
- **Cluster dependence:** live Redis required (tests self-skip with a `console.warn` if `getSharedRedis()` returns null)

## File Structure

| Path | Role |
|------|------|
| `e2e/state-persistence.test.ts` | `describe('Group State Isolation', ...)` block at line 514 — 4 `it()` tests |
| `src/k8s/ipc-redis.ts` | Production key-prefix logic for all group-scoped Redis operations |
| `e2e/setup.ts` | `getSharedRedis()`, `getNamespace()`, `flushTestKeys()` harness helpers |

## Tasks (retrospective)

### AC 1 — String key isolation between two groups

Group 1 writes `<NS>:group:<folder1>:state = {value: 100}` and group 2 writes `<NS>:group:<folder2>:state = {value: 200}`. Both are read back and confirmed independent: group 1 returns 100, group 2 returns 200. Proves that distinct group prefixes do not collide on same logical key names.

### AC 2 — Hash key isolation between two groups

Both groups write `key1` into their respective hash keys (`<NS>:data:<folder1>` and `<NS>:data:<folder2>`). After an update to group 2's value, group 1's hash field is confirmed unchanged at `value1-group1`. A `KEYS <NS>:data:*` scan confirms at least two distinct hash keys exist.

### AC 3 — Sorted-set (activity) isolation between two groups

Group 1's activity sorted-set contains `user-a` and `user-b`; group 2's contains `user-c` and `user-d`. A `ZRANGE` on each confirms the sets are fully disjoint: group 1 does not include group 2's members and vice-versa.

### AC 4 — Key-scan scope per group

Four keys are written: two `<NS>:group:<folder>` keys and two `<NS>:session:<folder>` keys across both groups. `KEYS <NS>:group:*` returns at least 2; `KEYS <NS>:session:*` returns at least 2. Confirms that namespace-scoped scans do not bleed across groups.

### Verification

Run: `npm run test:e2e -- state-persistence -t "Group State Isolation"`

Expected: **4 / 4 tests pass** — requires live Redis, completes in under 15 seconds.
