import { z } from 'zod';
import YAML from 'yaml';
import { MappingSchema } from './resolver.js';

const ConfigSchema = z.object({
  mappings: z.array(MappingSchema),
});
export type BrokerConfig = z.infer<typeof ConfigSchema>;

export function loadBrokerConfig(yamlText: string): BrokerConfig {
  const parsed = YAML.parse(yamlText);
  return ConfigSchema.parse(parsed);
}
