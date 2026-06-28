export function buildSmokeInput(
  parameters: Record<string, unknown>,
): Record<string, string> {
  const props =
    (parameters.properties as Record<string, { type?: string }> | undefined) ??
    {};
  const out: Record<string, string> = {};
  for (const [name, schema] of Object.entries(props)) {
    switch (schema.type) {
      case 'number':
      case 'integer':
        out[name] = '1';
        break;
      case 'boolean':
        out[name] = 'true';
        break;
      default:
        out[name] = 'smoke-test';
    }
  }
  return out;
}
