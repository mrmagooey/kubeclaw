/**
 * Attachment marker format constants and builder functions.
 *
 * Channels use the builder functions to embed attachment markers in message
 * content. The orchestrator uses the pattern constants to parse those markers
 * during the preprocessing gate.
 *
 * Format reference:
 *   [ImageAttachment: attachments/raw/<filename> caption="<text>"]
 *   [PdfAttachment: attachments/raw/<filename>]
 *   [VoiceAttachment: attachments/raw/<filename>]
 */

// ── Pattern constants (for the orchestrator / preprocessor) ──────────────────

/**
 * Matches `[ImageAttachment: attachments/raw/<path> caption="<text>"]`
 * Group 1: raw path (relative, starts with attachments/raw/)
 * Group 2: caption text (optional)
 */
export const IMAGE_ATTACHMENT_PATTERN =
  /\[ImageAttachment: (attachments\/raw\/[^\s\]]+)(?:\s+caption="([^"]*)")?\]/g;

/**
 * Matches `[PdfAttachment: attachments/raw/<path>]`
 * Group 1: raw path (relative, starts with attachments/raw/)
 */
export const PDF_ATTACHMENT_PATTERN =
  /\[PdfAttachment: (attachments\/raw\/[^\s\]]+)\]/g;

/**
 * Matches `[VoiceAttachment: attachments/raw/<path>]`
 * Group 1: raw path (relative, starts with attachments/raw/)
 */
export const VOICE_ATTACHMENT_PATTERN =
  /\[VoiceAttachment: (attachments\/raw\/[^\s\]]+)\]/g;

// ── Builder functions (for channels to call) ─────────────────────────────────

/**
 * Build an image attachment marker string for embedding in message content.
 *
 * @param rawPath  Relative path to the downloaded image, e.g.
 *                 `path.join('attachments', 'raw', filename)`
 * @param caption  Optional caption text from the platform message.
 *
 * @example
 *   content = imageAttachmentMarker(rawPath, msg.caption) + '\n' + content;
 */
export function imageAttachmentMarker(rawPath: string, caption?: string): string {
  if (caption) {
    return `[ImageAttachment: ${rawPath} caption="${caption}"]`;
  }
  return `[ImageAttachment: ${rawPath}]`;
}

/**
 * Build a PDF attachment marker string for embedding in message content.
 *
 * @param rawPath  Relative path to the downloaded PDF, e.g.
 *                 `path.join('attachments', 'raw', filename)`
 *
 * @example
 *   content = pdfAttachmentMarker(rawPath) + '\n' + content;
 */
export function pdfAttachmentMarker(rawPath: string): string {
  return `[PdfAttachment: ${rawPath}]`;
}

/**
 * Build a voice attachment marker string for embedding in message content.
 * Use this when deferring transcription to the preprocessing pipeline instead
 * of transcribing inline.
 *
 * @param rawPath  Relative path to the downloaded audio file, e.g.
 *                 `path.join('attachments', 'raw', filename)`
 *
 * @example
 *   content = voiceAttachmentMarker(rawPath) + '\n' + content;
 */
export function voiceAttachmentMarker(rawPath: string): string {
  return `[VoiceAttachment: ${rawPath}]`;
}
