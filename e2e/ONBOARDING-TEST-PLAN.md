# E2E User Onboarding Test Plan

## Overview

This document describes the end-to-end tests for simulating user onboarding and initial usage of NanoClaw without requiring real credentials or external API calls.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    E2E Test Framework                        │
├─────────────────────────────────────────────────────────────┤
│  Mock LLM Server (localhost:11434)                          │
│  - OpenAI API-compatible /v1/chat/completions               │
│  - Returns configurable responses                           │
├─────────────────────────────────────────────────────────────┤
│  Mock Channel System                                        │
│  - In-memory channel implementation                         │
│  - Simulates message send/receive                           │
├─────────────────────────────────────────────────────────────┤
│  Test Database                                              │
│  - In-memory SQLite (sql.js)                                │
│  - Isolated per test                                        │
├─────────────────────────────────────────────────────────────┤
│  Real Redis (from existing e2e setup)                       │
│  - Message queues, pub/sub                                  │
├─────────────────────────────────────────────────────────────┤
│  Test Files                                                 │
│  - mock-onboarding.test.ts - Setup flow verification        │
│  - mock-usage.test.ts - Message flow verification           │
└─────────────────────────────────────────────────────────────┘
```

## Components

### 1. Mock LLM Server (`e2e/lib/mock-llm-server.ts`)

A simple HTTP server that implements the OpenAI chat completions API:

- **Port**: 11434 (configurable)
- **Endpoints**:
  - `GET /v1/models` - Returns list of available models
  - `POST /v1/chat/completions` - Returns mock responses
- **Features**:
  - Response templates based on request content
  - Configurable delay simulation
  - Error simulation (rate limits, timeouts)
  - Token counting

### 2. Mock Channel System (`e2e/lib/mock-channel.ts`)

In-memory channel that simulates WhatsApp/Telegram:

- **Interface**: Implements `Channel` from `src/types.ts`
- **Features**:
  - `sendMessage(jid, content)` - Stores message in queue
  - `onMessage` callback - Simulates incoming messages
  - Mock JID format: `test-chat-{id}@mock.local`
- **Registration**: Uses existing `registerChannel` system

### 3. In-Memory SQLite (`e2e/lib/test-db.ts`)

Wrapper around sql.js for test isolation:

- **Features**:
  - Creates fresh DB per test
  - Uses in-memory storage
  - Provides helper functions for common operations
  - Supports schema initialization

### 4. Real Redis (existing)

Uses the existing e2e setup:

- Connects to `REDIS_URL` env var or localhost:6379
- Cleans up test keys after each test
- Tests pub/sub and queue functionality

## Test Files

### `e2e/mock-onboarding.test.ts`

Tests the complete setup flow:

| Test                            | Description                             |
| ------------------------------- | --------------------------------------- |
| `should initialize environment` | Creates .env file with mock credentials |
| `should build container`        | Verifies container image can be built   |
| `should start service`          | Service starts and connects to Redis    |
| `should register mock channel`  | Channel registers successfully          |
| `should create group`           | Group creation in DB                    |
| `should verify service health`  | Health endpoints respond                |

### `e2e/mock-usage.test.ts`

Tests basic message flow:

| Test                            | Description                       |
| ------------------------------- | --------------------------------- |
| `should route message to agent` | Message triggers agent invocation |
| `should get LLM response`       | Agent receives mock LLM response  |
| `should deliver response`       | Response sent back to channel     |
| `should handle trigger pattern` | Groups with prefix triggers       |
| `should isolate group state`    | Multiple groups don't interfere   |

## Response Templates

Located in `e2e/fixtures/mock-responses.json`:

```json
{
  "default": {
    "role": "assistant",
    "content": "Hello! I'm your NanoClaw assistant."
  },
  "greeting": {
    "role": "assistant",
    "content": "Hi there! How can I help you today?"
  },
  "error": {
    "role": "assistant",
    "content": "I'm sorry, I encountered an error processing your request."
  }
}
```

## Configuration

Environment variables for tests:

```bash
# LLM
LLM_PROVIDER=openrouter
OPENROUTER_API_URL=http://localhost:11434/v1
OPENROUTER_API_KEY=test-key
OPENROUTER_MODEL=test/model

# Database
TEST_DB_PATH=:memory:

# Redis
REDIS_URL=redis://localhost:6379
```

## Implementation Order

1. Create mock LLM server (`mock-llm-server.ts`)
2. Create mock channel (`mock-channel.ts`)
3. Create test DB helpers (`test-db.ts`)
4. Update e2e setup (`setup.ts`) to support mock mode
5. Create onboarding tests (`mock-onboarding.test.ts`)
6. Create usage tests (`mock-usage.test.ts`)
7. Add mock response fixtures
8. Run and verify tests

## Notes

- Tests are marked with `describe('Mock E2E')` to distinguish from existing e2e tests
- Each test cleans up its own resources
- Mock LLM server can run globally or per-test
- Use `test.onboard` and `test.use` from vitest for fixtures
