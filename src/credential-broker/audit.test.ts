import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { PinoAudit } from './audit.js';
import { logger } from '../logger.js';

describe('PinoAudit.record', () => {
  let audit: PinoAudit;

  beforeEach(() => {
    vi.clearAllMocks();
    audit = new PinoAudit();
  });

  it('calls logger.info exactly once per record() call', () => {
    audit.record({ destination: 'api.example.com', status: 200 });
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('passes the message string "authz decision"', () => {
    audit.record({ destination: 'api.example.com', status: 200 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(Object),
      'authz decision',
    );
  });

  it('merges kind: "credential-broker.authz" into the log object', () => {
    audit.record({ destination: 'api.example.com', status: 200 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'credential-broker.authz' }),
      'authz decision',
    );
  });

  it('passes destination and status from the event', () => {
    audit.record({ destination: 'api.example.com', status: 403 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ destination: 'api.example.com', status: 403 }),
      'authz decision',
    );
  });

  it('handles a minimal event with only destination and status', () => {
    audit.record({ destination: 'api.minimal.com', status: 200 });
    const [obj, msg] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toBe('authz decision');
    expect(obj).toMatchObject({
      kind: 'credential-broker.authz',
      destination: 'api.minimal.com',
      status: 200,
    });
    // Optional fields must not be present when not provided
    expect(obj.identity).toBeUndefined();
    expect(obj.ownerGroup).toBeUndefined();
    expect(obj.catalogId).toBeUndefined();
    expect(obj.keySource).toBeUndefined();
    expect(obj.substitutionCount).toBeUndefined();
  });

  it('includes optional identity field when present', () => {
    audit.record({ destination: 'api.example.com', status: 200, identity: 'sa/kubeclaw-tool-job' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ identity: 'sa/kubeclaw-tool-job' }),
      'authz decision',
    );
  });

  it('includes optional ownerGroup field when present', () => {
    audit.record({ destination: 'api.example.com', status: 200, ownerGroup: 'family' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ ownerGroup: 'family' }),
      'authz decision',
    );
  });

  it('includes optional catalogId field when present', () => {
    audit.record({ destination: 'api.replicate.com', status: 200, catalogId: 'replicate' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: 'replicate' }),
      'authz decision',
    );
  });

  it('includes optional keySource=groupSecret when present', () => {
    audit.record({ destination: 'api.example.com', status: 200, keySource: 'groupSecret' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ keySource: 'groupSecret' }),
      'authz decision',
    );
  });

  it('includes optional keySource=operatorFallback when present', () => {
    audit.record({ destination: 'api.example.com', status: 200, keySource: 'operatorFallback' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ keySource: 'operatorFallback' }),
      'authz decision',
    );
  });

  it('includes optional substitutionCount when present', () => {
    audit.record({ destination: 'api.example.com', status: 200, substitutionCount: 3 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ substitutionCount: 3 }),
      'authz decision',
    );
  });

  it('includes optional auditOnly and wouldStamp fields', () => {
    audit.record({ destination: 'api.example.com', status: 200, auditOnly: true, wouldStamp: false });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ auditOnly: true, wouldStamp: false }),
      'authz decision',
    );
  });

  it('includes optional mappingId when present', () => {
    audit.record({ destination: 'api.anthropic.com', status: 200, mappingId: 'anthropic' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ mappingId: 'anthropic' }),
      'authz decision',
    );
  });

  it('spreads all event fields after kind into the log object', () => {
    const event = {
      identity: 'sa/kubeclaw-tool-job',
      destination: 'api.replicate.com',
      mappingId: 'replicate',
      status: 200,
      auditOnly: false,
      wouldStamp: true,
      ownerGroup: 'family',
      catalogId: 'replicate',
      keySource: 'groupSecret' as const,
      substitutionCount: 1,
    };
    audit.record(event);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'credential-broker.authz', ...event }),
      'authz decision',
    );
  });

  it('calling record() twice calls logger.info exactly twice', () => {
    audit.record({ destination: 'api.example.com', status: 200 });
    audit.record({ destination: 'api.other.com', status: 403 });
    expect(logger.info).toHaveBeenCalledTimes(2);
  });
});
