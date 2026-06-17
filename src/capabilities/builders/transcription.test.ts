import { describe, it, expect, vi } from 'vitest';
import { parseAllDocuments } from 'yaml';

vi.mock('../../config.js', () => ({ KUBECLAW_NAMESPACE: 'kubeclaw' }));

import { buildYaml } from './index.js';
import type { TranscriptionCapabilitySpec } from '../types.js';

const base: TranscriptionCapabilitySpec = {
  kind: 'transcription',
  name: 'whisper',
  image: 'onerahmet/openai-whisper-asr-webservice:latest',
};

describe('generic transcription builder', () => {
  it('renders Deployment + Service on the default port 9000', () => {
    const yaml = buildYaml(base);
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('containerPort: 9000');
  });

  it('parses to exactly Deployment + Service (no PVC by default)', () => {
    const docs = parseAllDocuments(buildYaml(base)).map((d) => d.toJSON());
    expect(docs.map((d) => d.kind).sort()).toEqual(['Deployment', 'Service'].sort());
  });

  it('honours an explicit port', () => {
    const yaml = buildYaml({ ...base, port: 8080 });
    expect(yaml).toContain('containerPort: 8080');
  });

  it('applies SP1 gpu, startup probe, and podSecurity fields', () => {
    const yaml = buildYaml({
      ...base,
      resources: { gpu: 1 },
      probe: { type: 'http', path: '/health', startup: { failureThreshold: 60, periodSeconds: 5 } },
      podSecurity: { runAsNonRoot: true },
    });
    expect(yaml).toContain('nvidia.com/gpu');
    expect(yaml).toContain('startupProbe:');
    expect(yaml).toContain('runAsNonRoot: true');
  });
});
