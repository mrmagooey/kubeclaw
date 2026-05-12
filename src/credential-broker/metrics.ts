import { Counter, Histogram, Registry } from 'prom-client';

export interface AuthzMetricLabels {
  status: number;
  mappingId?: string;
  identity?: string;
  auditOnly: boolean;
  durationMs?: number;
}

export interface SecretFailureLabels {
  secretName: string;
}

export interface ConfigReloadLabels {
  result: 'success' | 'failure';
}

export interface BrokerMetrics {
  recordAuthz(labels: AuthzMetricLabels): void;
  recordSecretFailure(labels: SecretFailureLabels): void;
  recordConfigReload(labels: ConfigReloadLabels): void;
}

/**
 * Create and register all broker metrics on the given registry.
 *
 * Metrics are served on a dedicated port (9090) separate from the authz port
 * (8080). This prevents Prometheus scrape requests from appearing as authz
 * traffic and keeps the authz path's latency histogram clean.
 */
export function createMetrics(registry: Registry): BrokerMetrics {
  const authzTotal = new Counter({
    name: 'credential_broker_authz_total',
    help: 'Total authorization decisions made by the credential broker',
    labelNames: ['status', 'mapping_id', 'identity', 'audit_only'] as const,
    registers: [registry],
  });

  const authzDuration = new Histogram({
    name: 'credential_broker_authz_duration_seconds',
    help: 'Authorization decision latency in seconds',
    labelNames: ['mapping_id'] as const,
    registers: [registry],
  });

  const secretFailures = new Counter({
    name: 'credential_broker_secret_read_failures_total',
    help: 'Total number of K8s Secret read failures',
    labelNames: ['secret_name'] as const,
    registers: [registry],
  });

  const configReloads = new Counter({
    name: 'credential_broker_config_reloads_total',
    help: 'Total number of broker config file reloads',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  return {
    recordAuthz({ status, mappingId, identity, auditOnly, durationMs }) {
      authzTotal.inc({
        status: String(status),
        mapping_id: mappingId ?? '',
        identity: identity ?? '',
        audit_only: String(auditOnly),
      });
      if (durationMs !== undefined) {
        authzDuration.observe(
          { mapping_id: mappingId ?? '' },
          durationMs / 1000,
        );
      }
    },

    recordSecretFailure({ secretName }) {
      secretFailures.inc({ secret_name: secretName });
    },

    recordConfigReload({ result }) {
      configReloads.inc({ result });
    },
  };
}
