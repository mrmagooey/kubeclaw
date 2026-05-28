export interface GlobalSpecialist {
  name: string;
  prompt: string;
  triggers?: string[];
  llmProvider?: string;
  memory?: { isolated?: boolean };
  claudemd?: string;
  tools?: string[];
  maxToolRounds?: number;
  maxToolOutputBytes?: number;
}

export interface CatalogWire {
  version: 1;
  generation: number;
  specialists: GlobalSpecialist[];
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ALLOWED_KEYS = new Set([
  'name',
  'prompt',
  'triggers',
  'llmProvider',
  'memory',
  'claudemd',
  'tools',
  'maxToolRounds',
  'maxToolOutputBytes',
]);
const ALLOWED_MEMORY_KEYS = new Set(['isolated']);

export function validateSpecialist(s: unknown): ValidationResult {
  if (typeof s !== 'object' || s === null)
    return { ok: false, error: 'specialist must be an object' };
  const obj = s as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(k))
      return { ok: false, error: `unknown field: ${k}` };
  }
  if (typeof obj.name !== 'string' || !NAME_RE.test(obj.name)) {
    return { ok: false, error: `invalid name: ${JSON.stringify(obj.name)}` };
  }
  if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) {
    return { ok: false, error: 'prompt must be a non-empty string' };
  }
  if (
    obj.triggers !== undefined &&
    (!Array.isArray(obj.triggers) ||
      obj.triggers.some((t) => typeof t !== 'string'))
  ) {
    return { ok: false, error: 'triggers must be string[]' };
  }
  // Soft normalisation: strip leading '@' from trigger values so misconfigured
  // catalogs (e.g. triggers: ["@Researcher"]) don't silently fail to match.
  if (Array.isArray(obj.triggers)) {
    obj.triggers = (obj.triggers as string[]).map((t) =>
      t.startsWith('@') ? t.slice(1) : t,
    );
  }
  if (obj.llmProvider !== undefined && typeof obj.llmProvider !== 'string') {
    return { ok: false, error: 'llmProvider must be a string' };
  }
  if (obj.memory !== undefined) {
    if (typeof obj.memory !== 'object' || obj.memory === null)
      return { ok: false, error: 'memory must be an object' };
    const m = obj.memory as Record<string, unknown>;
    for (const k of Object.keys(m)) {
      if (!ALLOWED_MEMORY_KEYS.has(k))
        return { ok: false, error: `unknown memory field: ${k}` };
    }
    if (m.isolated !== undefined && typeof m.isolated !== 'boolean')
      return { ok: false, error: 'memory.isolated must be boolean' };
  }
  if (obj.claudemd !== undefined && typeof obj.claudemd !== 'string') {
    return { ok: false, error: 'claudemd must be a string' };
  }
  if (
    obj.tools !== undefined &&
    (!Array.isArray(obj.tools) || obj.tools.some((t) => typeof t !== 'string'))
  ) {
    return { ok: false, error: 'tools must be string[]' };
  }
  if (
    obj.maxToolRounds !== undefined &&
    (typeof obj.maxToolRounds !== 'number' ||
      !Number.isInteger(obj.maxToolRounds) ||
      obj.maxToolRounds < 1)
  ) {
    return {
      ok: false,
      error: 'maxToolRounds must be a positive integer',
    };
  }
  if (
    obj.maxToolOutputBytes !== undefined &&
    (typeof obj.maxToolOutputBytes !== 'number' ||
      !Number.isInteger(obj.maxToolOutputBytes) ||
      obj.maxToolOutputBytes < 1)
  ) {
    return {
      ok: false,
      error: 'maxToolOutputBytes must be a positive integer',
    };
  }
  return { ok: true };
}

export type ParseResult =
  | { ok: true; specialists: GlobalSpecialist[]; generation: number }
  | { ok: false; error: string };

export function parseSpecialists(json: string): ParseResult {
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
  if (!Array.isArray(obj.specialists))
    return { ok: false, error: 'specialists must be array' };
  const seen = new Set<string>();
  for (const s of obj.specialists) {
    const v = validateSpecialist(s);
    if (!v.ok) return { ok: false, error: v.error };
    const name = (s as GlobalSpecialist).name;
    if (seen.has(name)) return { ok: false, error: `duplicate name: ${name}` };
    seen.add(name);
  }
  return {
    ok: true,
    specialists: obj.specialists as GlobalSpecialist[],
    generation: obj.generation,
  };
}
