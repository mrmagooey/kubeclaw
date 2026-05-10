import { logger } from '../logger.js';
import type { AuditEvent } from './ext-authz.js';

export class PinoAudit {
  record(event: AuditEvent): void {
    logger.info(
      { kind: 'credential-broker.authz', ...event },
      'authz decision',
    );
  }
}
