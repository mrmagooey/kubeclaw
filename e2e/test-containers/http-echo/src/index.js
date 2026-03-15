/**
 * HTTP Echo Test Container
 *
 * Express server that:
 * - GET /agent/health -> returns { status: "healthy" }
 * - POST /agent/task -> accepts task payload, returns echo response
 *
 * Supports special commands:
 * - "CRASH" -> returns 500 error
 * - "TIMEOUT" -> never responds (simulates timeout)
 */

import express from 'express';

const PORT = parseInt(process.env.PORT || '8080', 10);

const app = express();
app.use(express.json({ limit: '50mb' }));

function log(message) {
  console.error(`[http-echo] ${message}`);
}

// Health check endpoint
app.get('/agent/health', (req, res) => {
  log('Health check received');
  res.json({ status: 'healthy' });
});

// Task processing endpoint
app.post('/agent/task', async (req, res) => {
  const task = req.body;

  // Support both the new adapter format (task.prompt) and the old format
  // (task.input.messages[].content) for backward compatibility.
  const content =
    task.prompt ||
    (task.input?.messages || []).filter((m) => m.role === 'user').pop()
      ?.content ||
    '';
  const sessionId = task.sessionId || task.input?.sessionId;

  log(`Processing task: "${content.substring(0, 50)}..."`);

  // Handle special commands
  if (content === 'CRASH') {
    log('CRASH command received - returning 500 error');
    return res.status(500).json({
      status: 'error',
      result: null,
      error: 'Simulated crash',
    });
  }

  if (content === 'TIMEOUT') {
    log('TIMEOUT command received - will not respond');
    // Never respond - simulates timeout
    return new Promise(() => {});
  }

  // Normal echo response
  // The adapter's AgentTaskResponse reads `sessionId` from the response body.
  // `result` is passed through as-is and the test checks `result.text`.
  const result = {
    status: 'success',
    result: { text: `Echo: ${content}` },
    sessionId:
      sessionId ||
      `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
  };

  log('Task completed successfully');
  res.json(result);
});

// Default handler for unknown routes
app.use((req, res) => {
  log(`Unknown route: ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  log(`Error: ${err.message}`);
  res.status(500).json({
    status: 'error',
    result: null,
    error: err.message,
  });
});

app.listen(PORT, () => {
  log(`HTTP Echo Test Container starting...`);
  log(`Listening on port ${PORT}`);
  log('Endpoints:');
  log('  GET  /agent/health');
  log('  POST /agent/task');
});
