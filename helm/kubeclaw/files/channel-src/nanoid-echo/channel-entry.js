import http from 'node:http';
import { nanoid } from 'nanoid';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200); res.end(JSON.stringify({ status: 'ok' })); return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: nanoid(), url: req.url }));
});
server.listen(PORT, '0.0.0.0', () => console.error('[nanoid-echo] listening on ' + PORT));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
