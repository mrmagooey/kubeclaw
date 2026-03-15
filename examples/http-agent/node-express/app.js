/**
 * Example NanoClaw HTTP Agent - Node.js Express
 *
 * A minimal agent that echoes back the prompt with some processing.
 * Implements the required /agent/health and /agent/task endpoints.
 */

import express from 'express';

const app = express();
app.use(express.json());

// Track sessions in memory (for demonstration)
const sessions = new Map();

/**
 * GET /agent/health
 * Health check endpoint. Return 200 when ready.
 */
app.get('/agent/health', (_req, res) => {
  res.json({ status: 'healthy' });
});

/**
 * POST /agent/task
 * Execute a task.
 *
 * Expected request body:
 * {
 *   "prompt": "user message",
 *   "sessionId": "optional",
 *   "context": {
 *     "groupFolder": "name",
 *     "chatJid": "jid",
 *     "isMain": false,
 *     "assistantName": "Andy"
 *   },
 *   "secrets": {"KEY": "value"}
 * }
 */
app.post('/agent/task', (req, res) => {
  const { prompt, sessionId, context = {} } = req.body;

  if (!prompt) {
    return res.status(400).json({ status: 'error', error: 'Missing prompt' });
  }

  const group = context.groupFolder || 'unknown';
  const assistant = context.assistantName || 'Agent';

  let result = `[${assistant}] Received in group '${group}': ${prompt}`;

  // Track session
  if (sessionId) {
    const count = (sessions.get(sessionId) || 0) + 1;
    sessions.set(sessionId, count);
    result += ` (session message #${count})`;
  }

  res.json({
    status: 'success',
    result,
    sessionId,
  });
});

const port = parseInt(process.env.PORT || '8080', 10);
app.listen(port, '0.0.0.0', () => {
  console.log(`Agent listening on port ${port}`);
});
