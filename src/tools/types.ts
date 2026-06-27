// Tool catalog types — the catalog entry IS a ToolSpec plus a per-channel ACL.
// Modeled on src/specialists/types.ts.

export interface RequestMapping {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** URL path on the user-tool container; {field} tokens are URL-encoded. Must begin with "/". */
  path: string;
  /** Query params; values are literals or "{field}" (URL-encoded). */
  query?: Record<string, string>;
  /** Headers; values are literals or "{field}" (raw string, newlines stripped). */
  headers?: Record<string, string>;
  /** JSON body template; string leaves equal to "{field}" preserve the field's JSON type. Omit for GET/DELETE. */
  body?: unknown;
  /** Optional dot-path to extract from a JSON response, e.g. "current.temp_c". */
  responsePath?: string;
}

export interface EgressRule {
  host: string;
  ports?: number[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
  image: string;
  pattern: 'http' | 'file' | 'acp' | 'cdp';
  port?: number; // http/acp: port the user container listens on (default 8080)
  command?: string[]; // optional entrypoint override for user container
  pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  memoryRequest?: string;
  memoryLimit?: string;
  cpuRequest?: string;
  cpuLimit?: string;
  /** Optional readiness-probe path on the user container (default "/"; must begin with "/"; any HTTP response counts as ready). */
  healthPath?: string;
  /** Optional per-tool HTTP request mapping (pattern 'http' only). When set, the
   *  bridge builds the real request from this instead of POSTing /invoke. */
  requestMapping?: RequestMapping;
  /** Filesystem the tool's container gets (file pattern). Default 'none'. */
  mount?: 'none' | 'scratch' | 'group';
  /** Only with mount: 'group'. Default false (read-write). */
  mountReadOnly?: boolean;
  /** Per-request shell command template run by the wrapper in the user-tool
   *  container; references fields as "$(cat "$INPUT_DIR/<field>")". pattern 'file' only. */
  run?: string;
  // ACP-specific (only when pattern = 'acp')
  acpAgentName?: string;
  acpMode?: 'sync' | 'async';
  /** Channels this tool is visible to. Empty/absent = all channels. */
  channels?: string[];
  /** Broker-catalog ids whose credentials this tool needs injected at egress.
   *  Each id resolves (orchestrator-side) to a placeholder env var on the
   *  user-tool container; the in-pod Envoy + broker substitute the real value at
   *  egress. Presence of any id triggers credential-sidecar attachment. */
  credentials?: string[];
  /** List of allowed external hosts this tool may connect to. */
  allowedEgress?: EgressRule[];
  /** Optional per-tool execution timeout in milliseconds. When set, overrides the
   *  caller-supplied default for the tool's sidecar Job (activeDeadlineSeconds) and
   *  the agent/channel result-wait deadline. */
  timeout?: number;
}

export interface ToolCatalogWire {
  version: 1;
  generation: number;
  tools: ToolSpec[];
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

// Reserved names a catalog tool may not use.
//
// Built-in / IPC tool names — names that are wired in-process by either the
// direct-llm-runner (TOOLS array + registerLocalTool calls) or the agent-runner
// (buildToolDefinitions: IPC, isMain, isSuperuser, and bootstrap tools).
// A catalog tool with any of these names would silently shadow the built-in.
//
// Also reserved: two retired spawn-category names kept defensively so a catalog
// tool cannot collide with a historical built-in category name.
const RESERVED_NAMES = new Set([
  // direct-llm-runner TOOLS array
  'approve_tool_credential',
  'cancel_task',
  'deploy_mcp_server',
  'execute_agent',
  'find_tools',
  'list_mcp_servers',
  'list_tasks',
  'pause_task',
  'propose_skill',
  'remove_mcp_server',
  'schedule_task',
  // direct-llm-runner registerLocalTool (constructor + channel-runner.ts)
  'list_credentials',
  'read_user_profile',
  'set_reminder',
  'update_profile',
  // agent-runner IPC tools (all contexts)
  'resume_task',
  'send_message',
  'update_task',
  // agent-runner isMain tools
  'control_channel',
  'deploy_channel',
  'register_group',
  // agent-runner isSuperuser tools
  'local_bash',
  'local_edit',
  'local_read',
  'local_write',
  // agent-runner bootstrap tools
  'ask_admin',
  'commit_channel_config',
  // retired spawn-category names (historical, kept defensively)
  'execution',
  'places',
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
  'requestMapping',
  'mount',
  'mountReadOnly',
  'run',
  'acpAgentName',
  'acpMode',
  'channels',
  'credentials',
  'allowedEgress',
  'timeout',
]);
const PATTERNS = new Set(['http', 'file', 'acp', 'cdp']);

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_MAPPING_KEYS = new Set([
  'method',
  'path',
  'query',
  'headers',
  'body',
  'responsePath',
]);

function validateRequestMapping(m: unknown): ValidationResult {
  if (typeof m !== 'object' || m === null)
    return { ok: false, error: 'requestMapping must be an object' };
  const obj = m as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_MAPPING_KEYS.has(k))
      return { ok: false, error: `unknown requestMapping field: ${k}` };
  }
  if (typeof obj.method !== 'string' || !HTTP_METHODS.has(obj.method))
    return {
      ok: false,
      error: 'requestMapping.method must be one of GET|POST|PUT|PATCH|DELETE',
    };
  if (typeof obj.path !== 'string' || !obj.path.startsWith('/'))
    return {
      ok: false,
      error: 'requestMapping.path must be a string beginning with "/"',
    };
  for (const f of ['query', 'headers'] as const) {
    if (obj[f] !== undefined) {
      if (
        typeof obj[f] !== 'object' ||
        obj[f] === null ||
        Array.isArray(obj[f])
      )
        return { ok: false, error: `requestMapping.${f} must be an object` };
      for (const v of Object.values(obj[f] as Record<string, unknown>)) {
        if (typeof v !== 'string')
          return {
            ok: false,
            error: `requestMapping.${f} values must be strings`,
          };
      }
    }
  }
  if (
    obj.responsePath !== undefined &&
    (typeof obj.responsePath !== 'string' || obj.responsePath.length === 0)
  )
    return {
      ok: false,
      error: 'requestMapping.responsePath must be a non-empty string',
    };
  return { ok: true };
}

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
    return { ok: false, error: 'pattern must be one of http|file|acp|cdp' };
  }
  if (
    obj.pattern === 'cdp' &&
    (obj.port === undefined || typeof obj.port !== 'number')
  ) {
    return {
      ok: false,
      error: 'cdp pattern requires a numeric port (the CDP port)',
    };
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
  if (obj.requestMapping !== undefined) {
    if (obj.pattern !== 'http')
      return {
        ok: false,
        error: 'requestMapping is only allowed when pattern is "http"',
      };
    const r = validateRequestMapping(obj.requestMapping);
    if (!r.ok) return r;
  }
  if (
    obj.mount !== undefined &&
    !['none', 'scratch', 'group'].includes(obj.mount as string)
  ) {
    return { ok: false, error: 'mount must be one of none|scratch|group' };
  }
  if (obj.mountReadOnly !== undefined) {
    if (typeof obj.mountReadOnly !== 'boolean')
      return { ok: false, error: 'mountReadOnly must be a boolean' };
    if (obj.mount !== 'group')
      return {
        ok: false,
        error: 'mountReadOnly is only valid with mount: group',
      };
  }
  if (obj.run !== undefined) {
    if (obj.pattern !== 'file')
      return { ok: false, error: 'run is only allowed when pattern is "file"' };
    if (typeof obj.run !== 'string' || obj.run.length === 0)
      return { ok: false, error: 'run must be a non-empty string' };
  }
  // Parameter property names become request filenames — guard against traversal.
  // This constraint is filesystem-safety only; http/acp tools use JSON keys where
  // hyphens and dots are legitimate JSON Schema identifiers.
  if (
    obj.pattern === 'file' &&
    obj.parameters &&
    typeof obj.parameters === 'object'
  ) {
    const props = (obj.parameters as { properties?: unknown }).properties;
    if (props && typeof props === 'object') {
      for (const key of Object.keys(props as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return {
            ok: false,
            error: `parameter property name not allowed: ${JSON.stringify(key)}`,
          };
        }
      }
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
  if (obj.credentials !== undefined) {
    if (!Array.isArray(obj.credentials)) {
      return { ok: false, error: 'credentials must be an array of strings' };
    }
    for (const c of obj.credentials) {
      if (typeof c !== 'string' || c.length === 0) {
        return {
          ok: false,
          error: 'each credentials entry must be a non-empty string',
        };
      }
    }
    if (obj.pattern === 'cdp' && obj.credentials.length > 0) {
      return {
        ok: false,
        error:
          'credentials is not supported for pattern "cdp" (no user-tool container to inject into)',
      };
    }
  }
  if (obj.timeout !== undefined) {
    if (
      typeof obj.timeout !== 'number' ||
      !Number.isInteger(obj.timeout) ||
      obj.timeout <= 0
    ) {
      return { ok: false, error: 'timeout must be a positive integer (ms)' };
    }
  }
  if (obj.allowedEgress !== undefined) {
    if (!Array.isArray(obj.allowedEgress)) {
      return { ok: false, error: 'allowedEgress must be an array' };
    }
    for (const rule of obj.allowedEgress as unknown[]) {
      if (typeof rule !== 'object' || rule === null) {
        return {
          ok: false,
          error: 'each allowedEgress entry must be an object',
        };
      }
      const r = rule as Record<string, unknown>;
      if (
        typeof r.host !== 'string' ||
        !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(r.host)
      ) {
        return {
          ok: false,
          error: 'allowedEgress host must be a valid hostname',
        };
      }
      if (r.ports !== undefined) {
        if (
          !Array.isArray(r.ports) ||
          r.ports.some((p) => typeof p !== 'number' || p < 1 || p > 65535)
        ) {
          return {
            ok: false,
            error: 'allowedEgress ports must be integers 1-65535',
          };
        }
      }
    }
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
