import { describe, it, expect } from 'vitest';
import {
  IMAGE_ATTACHMENT_PATTERN,
  PDF_ATTACHMENT_PATTERN,
  VOICE_ATTACHMENT_PATTERN,
  imageAttachmentMarker,
  pdfAttachmentMarker,
  voiceAttachmentMarker,
} from './attachment-markers.js';

function execAll(pattern: RegExp, text: string): RegExpExecArray[] {
  const re = new RegExp(pattern.source, pattern.flags);
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m);
  return out;
}

describe('imageAttachmentMarker', () => {
  it('emits the bare form when no caption is provided', () => {
    expect(imageAttachmentMarker('attachments/raw/photo.jpg')).toBe(
      '[ImageAttachment: attachments/raw/photo.jpg]',
    );
  });

  it('emits the captioned form when caption is non-empty', () => {
    expect(
      imageAttachmentMarker('attachments/raw/photo.jpg', 'sunset over the bay'),
    ).toBe(
      '[ImageAttachment: attachments/raw/photo.jpg caption="sunset over the bay"]',
    );
  });

  it('omits the caption clause when caption is an empty string', () => {
    expect(imageAttachmentMarker('attachments/raw/p.jpg', '')).toBe(
      '[ImageAttachment: attachments/raw/p.jpg]',
    );
  });
});

describe('pdfAttachmentMarker', () => {
  it('emits the bare form', () => {
    expect(pdfAttachmentMarker('attachments/raw/doc.pdf')).toBe(
      '[PdfAttachment: attachments/raw/doc.pdf]',
    );
  });
});

describe('voiceAttachmentMarker', () => {
  it('emits the bare form', () => {
    expect(voiceAttachmentMarker('attachments/raw/clip.ogg')).toBe(
      '[VoiceAttachment: attachments/raw/clip.ogg]',
    );
  });
});

describe('IMAGE_ATTACHMENT_PATTERN', () => {
  it('extracts the path from a captionless marker', () => {
    const text = 'before [ImageAttachment: attachments/raw/a.jpg] after';
    const matches = execAll(IMAGE_ATTACHMENT_PATTERN, text);
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('attachments/raw/a.jpg');
    expect(matches[0][2]).toBeUndefined();
  });

  it('extracts the path and caption from a captioned marker', () => {
    const text =
      '[ImageAttachment: attachments/raw/b.png caption="hello world"]';
    const matches = execAll(IMAGE_ATTACHMENT_PATTERN, text);
    expect(matches[0][1]).toBe('attachments/raw/b.png');
    expect(matches[0][2]).toBe('hello world');
  });

  it('matches multiple markers in a single string', () => {
    const text =
      'one [ImageAttachment: attachments/raw/x.jpg] two ' +
      '[ImageAttachment: attachments/raw/y.jpg caption="cap"] three';
    const matches = execAll(IMAGE_ATTACHMENT_PATTERN, text);
    expect(matches.map((m) => m[1])).toEqual([
      'attachments/raw/x.jpg',
      'attachments/raw/y.jpg',
    ]);
    expect(matches[1][2]).toBe('cap');
  });

  it('does not match paths outside attachments/raw/', () => {
    const text = '[ImageAttachment: other/dir/img.jpg]';
    expect(execAll(IMAGE_ATTACHMENT_PATTERN, text)).toHaveLength(0);
  });

  it('does not match when the prefix is wrong', () => {
    expect(
      execAll(IMAGE_ATTACHMENT_PATTERN, '[Image: attachments/raw/a.jpg]'),
    ).toHaveLength(0);
  });

  it('round-trips: builder output is matched by pattern', () => {
    const marker = imageAttachmentMarker('attachments/raw/r.jpg', 'a cap');
    const matches = execAll(IMAGE_ATTACHMENT_PATTERN, marker);
    expect(matches[0][1]).toBe('attachments/raw/r.jpg');
    expect(matches[0][2]).toBe('a cap');
  });
});

describe('PDF_ATTACHMENT_PATTERN', () => {
  it('extracts the path', () => {
    const matches = execAll(
      PDF_ATTACHMENT_PATTERN,
      'see [PdfAttachment: attachments/raw/doc.pdf] please',
    );
    expect(matches[0][1]).toBe('attachments/raw/doc.pdf');
  });

  it('round-trips: builder output is matched by pattern', () => {
    const marker = pdfAttachmentMarker('attachments/raw/d.pdf');
    const matches = execAll(PDF_ATTACHMENT_PATTERN, marker);
    expect(matches[0][1]).toBe('attachments/raw/d.pdf');
  });
});

describe('VOICE_ATTACHMENT_PATTERN', () => {
  it('extracts the path', () => {
    const matches = execAll(
      VOICE_ATTACHMENT_PATTERN,
      '[VoiceAttachment: attachments/raw/voice.ogg]',
    );
    expect(matches[0][1]).toBe('attachments/raw/voice.ogg');
  });

  it('round-trips: builder output is matched by pattern', () => {
    const marker = voiceAttachmentMarker('attachments/raw/v.ogg');
    const matches = execAll(VOICE_ATTACHMENT_PATTERN, marker);
    expect(matches[0][1]).toBe('attachments/raw/v.ogg');
  });
});
