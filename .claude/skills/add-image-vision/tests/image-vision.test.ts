import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('add-image-vision skill package', () => {
  describe('manifest', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf-8');
    });

    it('has a valid manifest.yaml', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'manifest.yaml'))).toBe(true);
      expect(content).toContain('skill: add-image-vision');
      expect(content).toContain('version: 2.0.0');
    });

    it('declares sharp as npm dependency', () => {
      expect(content).toContain('sharp:');
      expect(content).toMatch(/sharp:\s*"\^0\.34/);
    });

    it('has no env_additions', () => {
      expect(content).toContain('env_additions: []');
    });

    it('lists all add files', () => {
      expect(content).toContain('src/image.ts');
      expect(content).toContain('src/image.test.ts');
      expect(content).toContain('src/attachment-preprocessor.ts');
    });

    it('lists all modify files', () => {
      expect(content).toContain('container/agent-runner/src/index.ts');
    });

    it('does not reference dead files', () => {
      expect(content).not.toContain('src/container-runner.ts');
      // 'src/index.ts' alone (not as part of container/agent-runner/src/index.ts)
      expect(content).not.toMatch(/^  - src\/index\.ts$/m);
      // whatsapp handling moved to add-whatsapp base file
      expect(content).not.toContain('src/channels/whatsapp.ts');
    });

    it('has no channel dependencies', () => {
      expect(content).toContain('depends: []');
    });
  });

  describe('add/ files', () => {
    it('includes src/image.ts with magic byte detection', () => {
      const filePath = path.join(SKILL_DIR, 'add', 'src', 'image.ts');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function detectMimeType');
      expect(content).toContain("import sharp from 'sharp'");
      expect(content).toContain('MAGIC_BYTES');
    });

    it('includes src/image.test.ts', () => {
      const filePath = path.join(SKILL_DIR, 'add', 'src', 'image.test.ts');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('includes src/attachment-preprocessor.ts as K8s Job entrypoint', () => {
      const filePath = path.join(SKILL_DIR, 'add', 'src', 'attachment-preprocessor.ts');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('KUBECLAW_ATTACHMENTS');
      expect(content).toContain("startsWith('image/')");
      expect(content).toContain('.done');
      expect(content).toContain('sharp');
    });
  });

  describe('modify/ files exist', () => {
    it('includes modify/container/agent-runner/src/index.ts', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'modify', 'container', 'agent-runner', 'src', 'index.ts'))).toBe(true);
    });

    it('does not include dead modify/src/channels/whatsapp.ts', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'modify', 'src', 'channels', 'whatsapp.ts'))).toBe(false);
    });

    it('does not include dead modify/src/channels/whatsapp.test.ts', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'modify', 'src', 'channels', 'whatsapp.test.ts'))).toBe(false);
    });

    it('does not include dead modify/src/container-runner.ts', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'modify', 'src', 'container-runner.ts'))).toBe(false);
    });

    it('does not include dead modify/src/index.ts', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'modify', 'src', 'index.ts'))).toBe(false);
    });
  });
});
