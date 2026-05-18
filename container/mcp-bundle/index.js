#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startFilesystemServer } from './filesystem/server.js';

const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    root: { type: 'string' },
    port: { type: 'string' },
  },
});

const server = values.server;
const port = Number(values.port ?? 3000);

if (!server) {
  console.error('error: --server <name> is required');
  process.exit(2);
}

switch (server) {
  case 'filesystem': {
    if (!values.root) {
      console.error('error: --root is required for --server filesystem');
      process.exit(2);
    }
    await startFilesystemServer({ root: values.root, port });
    break;
  }
  default:
    console.error(`error: unknown --server "${server}"`);
    process.exit(2);
}
