import { buildSmokeInput } from './smoke-input.js';

describe('buildSmokeInput', () => {
  it('fills required params with type-appropriate benign values', () => {
    const params = {
      type: 'object',
      properties: { filename: { type: 'string' }, count: { type: 'number' }, flag: { type: 'boolean' } },
      required: ['filename', 'count'],
    };
    const input = buildSmokeInput(params);
    expect(input.filename).toBe('smoke-test');
    expect(input.count).toBe('1');
  });

  it('returns an empty object when there are no properties', () => {
    expect(buildSmokeInput({ type: 'object' })).toEqual({});
  });
});
