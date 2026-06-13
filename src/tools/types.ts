// Tool catalog types — the catalog entry IS a ToolSpec plus a per-channel ACL.
// Modeled on src/specialists/types.ts.

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
  image: string;
  pattern: 'http' | 'file' | 'acp';
  port?: number; // http/acp: port the user container listens on (default 8080)
  command?: string[]; // optional entrypoint override for user container
  pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  memoryRequest?: string;
  memoryLimit?: string;
  cpuRequest?: string;
  cpuLimit?: string;
  /** Optional readiness-probe path on the user container (default "/"; must begin with "/"; any HTTP response counts as ready). */
  healthPath?: string;
  // ACP-specific (only when pattern = 'acp')
  acpAgentName?: string;
  acpMode?: 'sync' | 'async';
  /** Channels this tool is visible to. Empty/absent = all channels. */
  channels?: string[];
}

export interface ToolCatalogWire {
  version: 1;
  generation: number;
  tools: ToolSpec[];
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

// Reserved: static built-in tool names (TOOL_SERVER_NAME keys in
// direct-llm-runner.ts). A catalog tool may not shadow or be shadowed by one.
const RESERVED_NAMES = new Set([
  'web_fetch',
  'web_search',
  'browser',
  'bash',
  'places_search',
]);

const ALLOWED_KEYS = new Set([
  'name',
  'description',
  'parameters',
  'image',
  'pattern',
  'port',
  'command',
  'pullPolicy',
  'memoryRequest',
  'memoryLimit',
  'cpuRequest',
  'cpuLimit',
  'healthPath',
  'acpAgentName',
  'acpMode',
  'channels',
]);
const PATTERNS = new Set(['http', 'file', 'acp']);

export function validateTool(t: unknown): ValidationResult {
  if (typeof t !== 'object' || t === null)
    return { ok: false, error: 'tool must be an object' };
  const obj = t as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(k))
      return { ok: false, error: `unknown field: ${k}` };
  }
  if (typeof obj.name !== 'string' || !NAME_RE.test(obj.name)) {
    return { ok: false, error: `invalid name: ${JSON.stringify(obj.name)}` };
  }
  if (RESERVED_NAMES.has(obj.name)) {
    return {
      ok: false,
      error: `name "${obj.name}" is reserved by a built-in tool`,
    };
  }
  if (typeof obj.description !== 'string' || obj.description.length === 0) {
    return { ok: false, error: 'description must be a non-empty string' };
  }
  if (typeof obj.parameters !== 'object' || obj.parameters === null) {
    return { ok: false, error: 'parameters must be an object' };
  }
  if (typeof obj.image !== 'string' || obj.image.length === 0) {
    return { ok: false, error: 'image must be a non-empty string' };
  }
  if (typeof obj.pattern !== 'string' || !PATTERNS.has(obj.pattern)) {
    return { ok: false, error: 'pattern must be one of http|file|acp' };
  }
  if (
    obj.port !== undefined &&
    (typeof obj.port !== 'number' ||
      !Number.isInteger(obj.port) ||
      obj.port < 1 ||
      obj.port > 65535)
  ) {
    return { ok: false, error: 'port must be an integer in 1..65535' };
  }
  if (
    obj.command !== undefined &&
    (!Array.isArray(obj.command) ||
      obj.command.some((c) => typeof c !== 'string'))
  ) {
    return { ok: false, error: 'command must be string[]' };
  }
  if (
    obj.pullPolicy !== undefined &&
    !['Always', 'IfNotPresent', 'Never'].includes(obj.pullPolicy as string)
  ) {
    return { ok: false, error: 'pullPolicy must be Always|IfNotPresent|Never' };
  }
  for (const f of [
    'memoryRequest',
    'memoryLimit',
    'cpuRequest',
    'cpuLimit',
  ] as const) {
    if (obj[f] !== undefined && typeof obj[f] !== 'string') {
      return { ok: false, error: `${f} must be a string` };
    }
  }
  if (obj.healthPath !== undefined) {
    if (typeof obj.healthPath !== 'string' || !obj.healthPath.startsWith('/')) {
      return {
        ok: false,
        error: 'healthPath must be a string beginning with "/"',
      };
    }
  }
  if (obj.acpAgentName !== undefined && typeof obj.acpAgentName !== 'string') {
    return { ok: false, error: 'acpAgentName must be a string' };
  }
  if (
    obj.acpMode !== undefined &&
    !['sync', 'async'].includes(obj.acpMode as string)
  ) {
    return { ok: false, error: 'acpMode must be sync|async' };
  }
  if (
    obj.channels !== undefined &&
    (!Array.isArray(obj.channels) ||
      obj.channels.some((c) => typeof c !== 'string'))
  ) {
    return { ok: false, error: 'channels must be string[]' };
  }
  return { ok: true };
}

export type ParseResult =
  | { ok: true; tools: ToolSpec[]; generation: number }
  | { ok: false; error: string };

export function parseToolCatalog(json: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e}` };
  }
  if (typeof parsed !== 'object' || parsed === null)
    return { ok: false, error: 'top-level must be object' };
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1)
    return { ok: false, error: `unsupported version: ${obj.version}` };
  if (typeof obj.generation !== 'number')
    return { ok: false, error: 'generation must be number' };
  if (!Array.isArray(obj.tools))
    return { ok: false, error: 'tools must be array' };
  const seen = new Set<string>();
  for (const t of obj.tools) {
    const v = validateTool(t);
    if (!v.ok) return { ok: false, error: v.error };
    const name = (t as ToolSpec).name;
    if (seen.has(name)) return { ok: false, error: `duplicate name: ${name}` };
    seen.add(name);
  }
  return {
    ok: true,
    tools: obj.tools as ToolSpec[],
    generation: obj.generation,
  };
}
