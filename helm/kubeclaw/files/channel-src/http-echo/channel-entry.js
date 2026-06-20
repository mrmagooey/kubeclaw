import http from 'node:http';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const INSTANCE = process.env.KUBECLAW_CHANNEL || 'http-echo';

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', channel: INSTANCE }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    channel: INSTANCE,
    method: req.method,
    url: req.url,
    headers: req.headers,
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.error('[http-echo] listening on port ' + PORT);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
