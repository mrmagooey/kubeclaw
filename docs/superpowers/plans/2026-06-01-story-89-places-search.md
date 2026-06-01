# Story 89 — `places_search` tool calls Google Places HTTP API and maps results

## Goal

Wire a `places_search` LocalTool into `DirectLLMRunner` that POSTs to the Google Places Text Search API, validates the response with Zod, and returns structured Place objects to the LLM.

## Architecture

An LLM `tool_call` for `places_search` is dispatched to `placesSearchHandler` in `src/runtime/places-search.ts`, which builds a JSON POST to `https://places.googleapis.com/v1/places:searchText` with the user query in the body and the API key in the `X-Goog-Api-Key` header. The raw HTTP response is parsed and validated against a Zod schema before each `places` element is mapped to a typed Place object (`displayName`, `formattedAddress`, `rating`, `types`) and returned to the LLM. When credentials are absent, the handler surfaces a structured error string rather than throwing.

## Tech Stack

- **Test runner:** vitest (e2e suite)
- **HTTP interception:** `vi.stubGlobal('fetch')` — no live Google API calls
- **Schema validation:** Zod
- **LLM harness:** in-process mock LLM server from `e2e/setup.ts`
- **No Kubernetes required** — all assertions run in-process

## File Structure

| File | Role |
|------|------|
| `e2e/places-search.test.ts` | E2e test suite (3 tests covering handler behaviour) |
| `src/runtime/places-search.ts` | `placesSearchHandler` + Zod schema for Google Places response |
| `src/runtime/direct-llm-runner.ts` | LocalTool registration for `places_search` |

## Tasks (retrospective)

### AC1 — HTTP POST to Google Places endpoint
`placesSearchHandler` constructs a POST request to `https://places.googleapis.com/v1/places:searchText`, sets `Content-Type: application/json`, places the query in `{"textQuery": <query>}`, and passes the API key via the `X-Goog-Api-Key` header.

### AC2 — Zod schema validation of HTTP response
The raw response JSON is parsed through a Zod schema that asserts the expected `places` array shape. A response that does not conform is rejected with a descriptive error string, not silently forwarded.

### AC3 — Place object mapping
Each validated `places` element is mapped to a plain object exposing `displayName`, `formattedAddress`, `rating`, and `types`, which is what the LLM receives back from the tool call.

### AC4 — Graceful credential-missing error
When `CREDENTIAL_INJECTION_MODE=off` and `GOOGLE_PLACES_API_KEY` is unset, the handler returns a structured error string (e.g. `"places_search: no API key configured"`) instead of throwing or crashing the runner.

### AC5 — LocalTool registration on DirectLLMRunner
`src/runtime/direct-llm-runner.ts` registers `places_search` as a LocalTool, wiring it to the real `placesSearchHandler` import and the real Zod schema — no module mocking in the registration path.

### Verification
Run: `npm run test:e2e -- places-search`
Expected: **3 / 3 passing**
