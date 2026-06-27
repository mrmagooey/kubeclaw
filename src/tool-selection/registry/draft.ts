import type { ToolSpec } from '../../tools/types.js';
import { validateTool } from '../../tools/types.js';
import type { ChatFn } from '../matcher.js';
import type { ImageMetadata } from './metadata.js';

export async function draftToolSpec(args: {
  taskDescription: string;
  metadata: ImageMetadata;
  chat: ChatFn;
}): Promise<{ ok: true; spec: ToolSpec } | { ok: false; error: string }> {
  if (!args.metadata.digest) {
    return { ok: false, error: 'image has no resolvable digest; refusing to draft a mutable-tag tool' };
  }

  const system =
    'You convert a container image into a KubeClaw ToolSpec. Respond with STRICT JSON only. ' +
    'Fields: name (snake_case), description, parameters (JSON Schema object), image, pattern ' +
    '("file"|"http"|"acp"|"cdp"), optional run (file pattern shell template using ' +
    '"$(cat \\"$INPUT_DIR/<param>\\")"), mount ("none"|"scratch"|"group"), allowedEgress ' +
    '([{host,ports}]). PREFER pattern "file" and NO credentials. Only include allowedEgress hosts ' +
    'the tool genuinely needs; an offline tool (e.g. metadata extraction) MUST use allowedEgress: [].';
  const user =
    `Task: ${args.taskDescription}\nImage: ${args.metadata.repo}\nReadme:\n${args.metadata.readme.slice(0, 4000)}`;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await args.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ])) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'unparseable draft' };
  }

  // Force digest pinning regardless of what the LLM wrote.
  parsed.image = `${args.metadata.repo}@${args.metadata.digest}`;

  const v = validateTool(parsed);
  if (!v.ok) return { ok: false, error: `drafted spec invalid: ${v.error}` };
  return { ok: true, spec: parsed as unknown as ToolSpec };
}
