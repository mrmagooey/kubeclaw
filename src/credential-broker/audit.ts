import { logger } from '../logger.js';

export class PinoAudit {
  record(event: {
    identity?: string;
    destination: string;
    mappingId?: string;
    status: number;
  }): void {
    logger.info(
      { kind: 'credential-broker.authz', ...event },
      'authz decision',
    );
  }
}
