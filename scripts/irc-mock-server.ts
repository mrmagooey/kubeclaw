/**
 * Standalone IRC Mock Server Entry Point
 *
 * This file provides a standalone entry point for running the mock IRC server
 * in a containerized environment.
 */
import { MockIRCServer } from '../e2e/lib/irc-server';

const PORT = parseInt(process.env.IRC_MOCK_PORT || '16667', 10);
const HOST = process.env.IRC_MOCK_HOST || '0.0.0.0';

async function main() {
  console.log('Starting Mock IRC Server...');
  console.log(`Configuration: host=${HOST}, port=${PORT}`);

  const server = new MockIRCServer(PORT, HOST);

  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully...');
    await server.stop();
    process.exit(0);
  });

  try {
    await server.start();
    console.log('Mock IRC Server is running and ready to accept connections');
  } catch (error) {
    console.error('Failed to start Mock IRC Server:', error);
    process.exit(1);
  }
}

main();
