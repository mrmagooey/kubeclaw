import { z } from 'zod';
import YAML from 'yaml';
import { MappingSchema, CatalogEntrySchema } from './resolver.js';

const ConfigSchema = z
  .object({
    mappings: z.array(MappingSchema).default([]),
    catalog: z.array(CatalogEntrySchema).default([]),
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
