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
      expect(content).toContain('src/channels/whatsapp.ts');
      expect(content).toContain('src/channels/whatsapp.test.ts');
      expect(content).toContain('container/agent-runner/src/index.ts');
    });

    it('does not reference dead files', () => {
      expect(content).not.toContain('src/container-runner.ts');
      // 'src/index.ts' alone (not as part of container/agent-runner/src/index.ts)
      expect(content).not.toMatch(/^  - src\/index\.ts$/m);
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
      expect(content).toContain('export function isImageMessage');
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
    const modifyFiles = [
      'src/channels/whatsapp.ts',
      'src/channels/whatsapp.test.ts',
      'container/agent-runner/src/index.ts',
    ];

    for (const file of modifyFiles) {
      it(`includes modify/${file}`, () => {
        const filePath = path.join(SKILL_DIR, 'modify', file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }

    it('does not include dead modify/src/container-runner.ts', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'modify', 'src', 'container-runner.ts'))).toBe(false);
    });

    it('does not include dead modify/src/index.ts', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'modify', 'src', 'index.ts'))).toBe(false);
    });
  });

  describe('modify/src/channels/whatsapp.ts', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify', 'src', 'channels', 'whatsapp.ts'),
        'utf-8',
      );
    });

    it('imports detectMimeType from image.js', () => {
      expect(content).toContain("from '../image.js'");
      expect(content).toContain('detectMimeType');
    });

    it('imports downloadMediaMessage from baileys', () => {
      expect(content).toContain('downloadMediaMessage');
      expect(content).toContain("from '@whiskeysockets/baileys'");
    });

    it('emits typed ImageAttachment markers', () => {
      expect(content).toContain('[ImageAttachment:');
      expect(content).toContain('attachments/raw/');
    });

    it('emits typed PdfAttachment markers', () => {
      expect(content).toContain('[PdfAttachment:');
    });

    it('uses magic byte detection not hardcoded type', () => {
      expect(content).toContain('detectMimeType(buffer)');
      expect(content).not.toContain('type=image/jpeg');
    });

    it('preserves core WhatsAppChannel structure', () => {
      expect(content).toContain('export class WhatsAppChannel implements Channel');
      expect(content).toContain('async connect()');
      expect(content).toContain('async sendMessage(');
      expect(content).toContain('async syncGroupMetadata(');
      expect(content).toContain('private async translateJid(');
      expect(content).toContain('private async flushOutgoingQueue(');
    });
  });
});
