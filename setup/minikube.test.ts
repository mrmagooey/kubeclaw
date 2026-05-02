import { describe, it, expect } from 'vitest';

import { parseArgs } from './minikube.js';

describe('parseArgs', () => {
  it('returns default opts when no args are given', () => {
    const opts = parseArgs([]);
    expect(opts.cpus).toBe(4);
    expect(opts.memory).toBe(6144);
    expect(opts.disk).toBe('20g');
    expect(opts.reset).toBe(false);
    expect(opts.skipBuild).toBe(false);
    expect(opts.skipFalco).toBe(false);
    expect(opts.profile).toBe('');
  });

  it('parses --profile <name>', () => {
    const opts = parseArgs(['--profile', 'kubeclaw']);
    expect(opts.profile).toBe('kubeclaw');
  });

  it('parses --profile alongside other flags', () => {
    const opts = parseArgs(['--reset', '--profile', 'dev', '--cpus', '6']);
    expect(opts.reset).toBe(true);
    expect(opts.profile).toBe('dev');
    expect(opts.cpus).toBe(6);
  });

  it('leaves profile empty when --profile is not supplied', () => {
    const opts = parseArgs(['--skip-build', '--memory', '8192']);
    expect(opts.profile).toBe('');
    expect(opts.skipBuild).toBe(true);
    expect(opts.memory).toBe(8192);
  });

  it('parses --reset flag', () => {
    expect(parseArgs(['--reset']).reset).toBe(true);
  });

  it('parses --skip-build flag', () => {
    expect(parseArgs(['--skip-build']).skipBuild).toBe(true);
  });

  it('parses --skip-falco flag', () => {
    expect(parseArgs(['--skip-falco']).skipFalco).toBe(true);
  });

  it('parses --cpus value', () => {
    expect(parseArgs(['--cpus', '8']).cpus).toBe(8);
  });

  it('parses --memory value', () => {
    expect(parseArgs(['--memory', '4096']).memory).toBe(4096);
  });

  it('parses --disk value', () => {
    expect(parseArgs(['--disk', '40g']).disk).toBe('40g');
  });
});
