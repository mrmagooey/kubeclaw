# Story 125: Mock Usage — Channel + LLM Routing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify that the mock-channel + mock-LLM harness exercises message routing end-to-end (channel → orchestrator → LLM → response → channel) without requiring a live Kubernetes cluster, enabling cheap integration-level correctness checks on developer laptops.

**Architecture:** `src/channel-runner.ts` drives the routing loop: it reads messages from a mock channel, dispatches to the orchestrator, which calls the mock LLM server (an in-process HTTP server on port 11434), and delivers the LLM response back to the channel's queued-messages buffer. The e2e harness in `e2e/lib/` wires up a real SQLite database and a real Redis connection (via kubectl port-forward) but replaces the Kubernetes cluster and real LLM with lightweight in-process fakes.

**Tech Stack:** vitest (e2e runner), in-process HTTP mock LLM server, SQLite (real), ioredis (real via port-forward), no Kubernetes required

---

## Retrospective

This plan is retrospective — the implementation already exists and all 5/5 tests in the `Mock E2E Usage > Message Routing` describe block pass. The tasks below describe what was built and how it was verified.

## File Structure

| Path | Role |
|------|------|
| `e2e/mock-usage.test.ts` | Full e2e test suite; `describe('Mock E2E Usage', ...)` → `describe('Message Routing', ...)` — 5 `it()` tests |
| `src/channel-runner.ts` | Message routing loop: channel → orchestrator → LLM → response → channel |
| `e2e/lib/` | Harness utilities: mock channel, mock LLM server, test DB initialization |

---

## Tasks (retrospective — already implemented)

### Task 1: Mock LLM server

**Files:**
- `e2e/mock-usage.test.ts` — `beforeEach`/`afterEach` lifecycle for mock LLM server

- [x] **Step 1: Start mock LLM server**

Launches an in-process HTTP server on port 11434 that returns configurable templated responses to LLM requests, simulating Ollama's API surface.

- [x] **Step 2: Initialize test database**

Creates a real SQLite database with all schema migrations applied so message persistence is exercised without mocking.

- [x] **Step 3: Connect to Redis**

Opens a real ioredis connection to the port-forwarded cluster Redis, verifying ACL credentials before tests run.

- [x] **Step 4: Teardown**

Stops the mock LLM server, cleans up test data, and closes the Redis connection in `afterEach`.

---

### Task 2: AC 1 — Route message through channel

**Files:**
- `e2e/mock-usage.test.ts` — `it('should route message through channel', ...)`

- [x] **Step 1: Write the test**

Publishes a message to the mock channel and verifies the channel runner picks it up and routes it through the orchestrator.

- [x] **Step 2: Run the test**

```bash
npm run test:e2e -- mock-usage -t "should route message through channel"
```

Expected: PASS (~109ms)

---

### Task 3: AC 2 — Get response from mock LLM

**Files:**
- `e2e/mock-usage.test.ts` — `it('should get response from mock LLM', ...)`

- [x] **Step 1: Write the test**

Sends a message through the full routing path and asserts the mock LLM server was invoked and returned a response body.

- [x] **Step 2: Run the test**

```bash
npm run test:e2e -- mock-usage -t "should get response from mock LLM"
```

Expected: PASS (~24ms)

---

### Task 4: AC 3 — Deliver response to channel

**Files:**
- `e2e/mock-usage.test.ts` — `it('should deliver response to channel', ...)`

- [x] **Step 1: Write the test**

Asserts the LLM response is placed into the mock channel's queued-messages buffer after routing completes.

- [x] **Step 2: Run the test**

```bash
npm run test:e2e -- mock-usage -t "should deliver response to channel"
```

Expected: PASS (~6ms)

---

### Task 5: AC 4 — End-to-end conversation flow

**Files:**
- `e2e/mock-usage.test.ts` — `it('should handle end-to-end conversation flow', ...)`

- [x] **Step 1: Write the test**

Drives multiple conversation turns through the channel runner, verifying state accumulates correctly across turns.

- [x] **Step 2: Run the test**

```bash
npm run test:e2e -- mock-usage -t "should handle end-to-end conversation flow"
```

Expected: PASS (~9ms)

---

### Task 6: AC 5 — Custom response templates

**Files:**
- `e2e/mock-usage.test.ts` — `it('should support custom response templates', ...)`

- [x] **Step 1: Write the test**

Configures the mock LLM with a custom response template per test and verifies the channel runner surfaces the custom response to the channel.

- [x] **Step 2: Run the test**

```bash
npm run test:e2e -- mock-usage -t "should support custom response templates"
```

Expected: PASS (~15ms)

---

## Verification

Run all five `Mock E2E Usage > Message Routing` tests together:

```bash
npm run test:e2e -- mock-usage
```

Expected: **5 / 5 tests pass** — requires Redis via minikube + kubectl port-forward on localhost:16379. No cluster pods are needed; all Kubernetes interactions are replaced by in-process mocks.
