import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('pdf-reader skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: add-pdf-reader');
    expect(content).toContain('version: 1.1.0');
    expect(content).toContain('container/Dockerfile');
  });

  it('has all files declared in adds', () => {
    const skillMd = path.join(skillDir, 'add', 'container', 'skills', 'pdf-reader', 'SKILL.md');
    const pdfReaderScript = path.join(skillDir, 'add', 'container', 'skills', 'pdf-reader', 'pdf-reader');

    expect(fs.existsSync(skillMd)).toBe(true);
    expect(fs.existsSync(pdfReaderScript)).toBe(true);
  });

  it('pdf-reader script is a valid Bash script', () => {
    const scriptPath = path.join(skillDir, 'add', 'container', 'skills', 'pdf-reader', 'pdf-reader');
    const content = fs.readFileSync(scriptPath, 'utf-8');

    // Valid shell script
    expect(content).toMatch(/^#!/);

    // Core CLI commands
    expect(content).toContain('pdftotext');
    expect(content).toContain('pdfinfo');
    expect(content).toContain('extract');
    expect(content).toContain('fetch');
    expect(content).toContain('info');
    expect(content).toContain('list');

    // Key options
    expect(content).toContain('--layout');
    expect(content).toContain('--pages');
  });

  it('container skill SKILL.md has correct frontmatter', () => {
    const skillMdPath = path.join(skillDir, 'add', 'container', 'skills', 'pdf-reader', 'SKILL.md');
    const content = fs.readFileSync(skillMdPath, 'utf-8');

    expect(content).toContain('name: pdf-reader');
    expect(content).toContain('allowed-tools: Bash(pdf-reader:*)');
    expect(content).toContain('pdf-reader extract');
    expect(content).toContain('pdf-reader fetch');
    expect(content).toContain('pdf-reader info');
  });

  it('has all files declared in modifies', () => {
    const dockerfile = path.join(skillDir, 'modify', 'container', 'Dockerfile');
    expect(fs.existsSync(dockerfile)).toBe(true);
  });

  it('has intent files for all modified files', () => {
    expect(
      fs.existsSync(path.join(skillDir, 'modify', 'container', 'Dockerfile.intent.md')),
    ).toBe(true);
  });

  it('does not include dead whatsapp.ts modify (PDF handling moved to add-whatsapp)', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts'))).toBe(false);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts'))).toBe(false);
  });

  it('modified Dockerfile includes poppler-utils and pdf-reader', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'container', 'Dockerfile'),
      'utf-8',
    );

    expect(content).toContain('poppler-utils');
    expect(content).toContain('pdf-reader');
    expect(content).toContain('/usr/local/bin/pdf-reader');
  });

  it('modified Dockerfile preserves core structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'container', 'Dockerfile'),
      'utf-8',
    );

    expect(content).toContain('FROM node:22-slim');
    expect(content).toContain('chromium');
    expect(content).toContain('agent-browser');
    expect(content).toContain('WORKDIR /app');
    expect(content).toContain('COPY agent-runner/');
    expect(content).toContain('ENTRYPOINT');
    expect(content).toContain('/workspace/group');
    expect(content).toContain('USER node');
  });

});
