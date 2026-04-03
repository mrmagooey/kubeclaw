const http = require('http');

const runs = new Map();
let runCounter = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${process.env.PORT || 8080}`);

  // POST /runs — create a run
  if (req.method === 'POST' && url.pathname === '/runs') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const data = JSON.parse(body);
      const input = (data.input || [])
        .flatMap(m => (m.parts || []).map(p => p.content))
        .join(' ');
      const agentName = data.agent_name || 'echo';

      if (data.mode === 'synchronous') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'completed',
          output: [{ role: 'assistant', parts: [{ content: `[${agentName}] Echo: ${input}`, content_type: 'text/plain' }] }],
        }));
      } else {
        const runId = `run-${++runCounter}`;
        // Simulate async: complete after 2 seconds
        runs.set(runId, { status: 'running', input, agentName });
        setTimeout(() => {
          const r = runs.get(runId);
          if (r) r.status = 'completed';
        }, 2000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ run_id: runId, status: 'queued' }));
      }
    });
    return;
  }

  // GET /runs/:id — check run status
  const match = url.pathname.match(/^\/runs\/(.+)$/);
  if (req.method === 'GET' && match) {
    const run = runs.get(match[1]);
    if (!run) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const resp = { run_id: match[1], status: run.status };
    if (run.status === 'completed') {
      resp.output = [{ role: 'assistant', parts: [{ content: `[${run.agentName}] Echo: ${run.input}`, content_type: 'text/plain' }] }];
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resp));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const port = process.env.PORT || 8080;
server.listen(port, () => console.log(`ACP echo server on :${port}`));
