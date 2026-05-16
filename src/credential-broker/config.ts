import { z } from 'zod';
import YAML from 'yaml';
import { MappingSchema, CatalogEntrySchema } from './resolver.js';

// Defensive: accept null (YAML "catalog:" with no body renders as null) and
// coerce to [] before validation. Distinct from `.default([])` which only
// applies when the key is missing.
const NullableArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => (v == null ? [] : v), z.array(item));

const ConfigSchema = z
  .object({
    mappings: NullableArray(MappingSchema),
    catalog: NullableArray(CatalogEntrySchema),
  })
  .refine(
    (c) => {
      const ids = c.catalog.map((e) => e.id);
      return new Set(ids).size === ids.length;
    },
    { message: 'catalog ids must be unique' },
  );
export type BrokerConfig = z.infer<typeof ConfigSchema>;

export function loadBrokerConfig(yamlText: string): BrokerConfig {
  const parsed = YAML.parse(yamlText);
  return ConfigSchema.parse(parsed);
}
