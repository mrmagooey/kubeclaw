/**
 * Test script for Redis IPC client
 *
 * Tests Redis connection with ACL credentials and stream operations
 */

import { RedisIPCClient } from '../src/redis-ipc.js';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests(): Promise<void> {
  console.error('=== Redis IPC Client Tests ===\n');

  // Get configuration from environment
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const redisUsername = process.env.REDIS_USERNAME || 'default';
  const redisPassword = process.env.REDIS_PASSWORD || '';
  const jobId = process.env.NANOCLAW_JOB_ID || 'test-job-' + Date.now();

  console.error('Configuration:');
  console.error(`  URL: ${redisUrl}`);
  console.error(`  Username: ${redisUsername}`);
  console.error(`  Job ID: ${jobId}`);
  console.error();

  const client = new RedisIPCClient({
    url: redisUrl,
    username: redisUsername,
    password: redisPassword,
    jobId,
  });

  // Test 1: Connection
  console.error('Test 1: Connect to Redis');
  try {
    await client.connect();
    console.error('  ✓ Connected successfully\n');
  } catch (err) {
    console.error(`  ✗ Connection failed: ${err}\n`);
    process.exit(1);
  }

  // Test 2: Send output
  console.error('Test 2: Send output message');
  try {
    await client.sendOutput({
      status: 'success',
      result: 'Hello from test script',
      newSessionId: 'test-session-123',
    });
    console.error('  ✓ Output sent successfully\n');
  } catch (err) {
    console.error(`  ✗ Failed to send output: ${err}\n`);
    await client.disconnect();
    process.exit(1);
  }

  // Test 3: Listen for messages (with timeout)
  console.error(
    'Test 3: Listen for messages (will timeout after 5s if no messages)',
  );
  console.error('  Send a message to the stream to test:');
  console.error(
    `  XADD nanoclaw:input:${jobId} * type followup prompt "Test followup"`,
  );
  console.error();

  const timeout = setTimeout(async () => {
    console.error('  Test timed out (expected if no messages sent)\n');
    await client.disconnect();
    console.error('=== All tests passed ===');
    process.exit(0);
  }, 5000);

  try {
    for await (const message of client.listenForMessages()) {
      clearTimeout(timeout);
      console.error('  ✓ Received message:', message);

      if (message.type === 'close') {
        console.error('  ✓ Close signal received\n');
        break;
      }
    }
  } catch (err) {
    clearTimeout(timeout);
    console.error(`  ✗ Error listening for messages: ${err}\n`);
    await client.disconnect();
    process.exit(1);
  }

  // Test 4: Disconnect
  console.error('Test 4: Disconnect from Redis');
  try {
    await client.disconnect();
    console.error('  ✓ Disconnected successfully\n');
  } catch (err) {
    console.error(`  ✗ Disconnect failed: ${err}\n`);
    process.exit(1);
  }

  console.error('=== All tests passed ===');
}

runTests().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
