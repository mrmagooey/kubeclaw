# Redis ACL-Based Follow-Up Support Implementation

## Summary

Implemented bidirectional Redis-based communication for file-adapter and http-adapter sidecars, enabling follow-up message support with Redis ACL authentication.

## Files Created/Modified

### 1. File Adapter (`container/file-adapter/`)

**New Files:**

- `src/redis-ipc.ts` - Redis IPC client class with:
  - ACL-based authentication (username/password)
  - Stream-based message listening (`XREAD`)
  - Pub/Sub output publishing
  - Auto-reconnection with exponential backoff
  - Type-safe message handling

- `tests/test-redis.ts` - Test script for Redis functionality

**Modified Files:**

- `src/index.ts` - Updated main() function to:
  - Read Redis connection details from env vars
  - Validate required environment variables (fail fast)
  - Connect to Redis with ACL credentials
  - Send results via Redis (primary) with stdout fallback
  - Listen for follow-up messages via Redis Streams
  - Process follow-ups through file IPC loop
  - Handle `_close` sentinel for graceful shutdown

- `package.json` - Added `redis: ^4.7.0` dependency

### 2. HTTP Adapter (`container/http-adapter/`)

**New Files:**

- `src/redis-ipc.ts` - Same Redis IPC client as file-adapter
- `tests/test-redis.ts` - Test script for Redis functionality

**Modified Files:**

- `src/index.ts` - Updated main() function similar to file-adapter:
  - Redis connection with ACL credentials
  - HTTP health check and task sending
  - Results sent via Redis instead of stdout
  - Follow-up message listening via Redis Streams
  - Additional HTTP POSTs for follow-ups

- `package.json` - Added `redis: ^4.7.0` dependency

## Key Implementation Details

### Environment Variables Required

```
REDIS_URL=redis://kubeclaw-redis:6379
REDIS_USERNAME=sidecar-{jobId}
REDIS_PASSWORD={generated-password}
KUBECLAW_JOB_ID={jobId}
```

### Redis Streams Usage

- **Input Stream:** `kubeclaw:input:{jobId}` - Follow-up messages from orchestrator
- **Output Channel:** `kubeclaw:output:{jobId}` - Results from sidecar to orchestrator

### Message Format

Input messages (via XADD):

```
type: "followup" | "close"
prompt: string (for followup type)
sessionId: string (optional)
```

Output messages (via PUBLISH):

```typescript
{
  status: 'success' | 'error',
  result: string | null,
  newSessionId?: string,
  error?: string
}
```

### Error Handling

- **Fail fast:** Exits immediately if required env vars are missing
- **Connection retry:** Exponential backoff (100ms → 10s max, 10 retries)
- **Graceful degradation:** Falls back to stdout markers if Redis fails
- **Logging:** All logs go to stderr (stdout reserved for protocol)

### Backward Compatibility

- Initial task still read from stdin
- Stdout markers still written as fallback
- Existing file IPC and HTTP client logic unchanged
- Idle timeout (30 min) prevents runaway processes

## Testing

### Manual Testing

```bash
# File Adapter
cd container/file-adapter
npm install
npm run build
REDIS_URL=redis://localhost:6379 REDIS_USERNAME=default REDIS_PASSWORD=pass KUBECLAW_JOB_ID=test-job npx tsx tests/test-redis.ts

# HTTP Adapter
cd container/http-adapter
npm install
npm run build
REDIS_URL=redis://localhost:6379 REDIS_USERNAME=default REDIS_PASSWORD=pass KUBECLAW_JOB_ID=test-job npx tsx tests/test-redis.ts
```

### Integration Testing

To test with a running Redis instance:

1. Start Redis with ACL enabled
2. Create ACL user: `ACL SETUSER sidecar-test on >password ~kubeclaw:* +@all`
3. Run adapter with env vars pointing to test Redis
4. Use `redis-cli` to send follow-up messages:
   ```bash
   XADD kubeclaw:input:test-job * type followup prompt "Hello followup"
   ```
5. Verify output received on: `SUBSCRIBE kubeclaw:output:test-job`

## Build Instructions

### Local Development

```bash
# File Adapter
cd container/file-adapter
npm install
npm run build

# HTTP Adapter
cd container/http-adapter
npm install
npm run build
```

### Docker Rebuild (if using containerized deployment)

```bash
# Rebuild sidecar adapters
cd container
./build.sh

# Or individually:
docker build -t kubeclaw-file-adapter:latest -f file-adapter/Dockerfile .
docker build -t kubeclaw-http-adapter:latest -f http-adapter/Dockerfile .
```

## Challenges Encountered

1. **Type Safety:** Added explicit type annotations for Redis client event handlers
2. **Connection Management:** Implemented proper cleanup and reconnection logic
3. **Stream vs Pub/Sub:** Used Redis Streams for input (persistent, ordered) and Pub/Sub for output (fire-and-forget)
4. **Backpressure:** Used blocking XREAD with timeout to avoid busy-waiting

## Next Steps

1. Orchestrator needs to be updated to:
   - Create Redis ACL users per job
   - Send follow-up messages via XADD
   - Listen for responses via SUBSCRIBE
2. Update Docker Compose/deployment configs to include Redis

3. Add metrics/monitoring for Redis connection health
