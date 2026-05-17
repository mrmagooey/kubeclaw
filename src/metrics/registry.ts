import http from 'http';
import { Registry } from 'prom-client';
import { logger } from '../logger.js';

export interface MetricsServerOptions {
  registry: Registry;
  /** Pass 0 to bind to an OS-assigned port (useful in tests). */
  port: number;
}

export interface ListenResult {
  port: number;
}

export interface MetricsServer {
  /** Start listening. Resolves once the port is bound. */
  listen(): Promise<ListenResult>;
  /** Gracefully close the server. */
  close(): Promise<void>;
}

/**
 * Create a minimal HTTP server that serves a prom-client Registry on GET /metrics.
 *
 * Mirrors the pattern in src/credential-broker/index.ts — a dedicated metrics
 * server runs on a separate port so scrape traffic does not appear in any
 * workload-specific histogram the tier is recording.
 */
export function createMetricsServer(opts: MetricsServerOptions): MetricsServer {
  const { registry, port } = opts;

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await registry.metrics();
      res.setHeader('Content-Type', registry.contentType);
      res.writeHead(200).end(body);
    } catch (err) {
      logger.error({ err }, 'metrics handler crashed');
      res.writeHead(500).end();
    }
  });

  return {
    listen() {
      return new Promise<ListenResult>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          const addr = server.address();
          const boundPort =
            addr && typeof addr === 'object' ? addr.port : port;
          logger.info({ port: boundPort }, 'metrics server listening');
          resolve({ port: boundPort });
        });
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
