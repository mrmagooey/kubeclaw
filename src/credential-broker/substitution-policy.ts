export interface PolicyOpts {
  perPlaceholderMax: number;
  totalMax: number;
}

export class SubstitutionPolicy {
  constructor(private readonly opts: PolicyOpts) {}

  validateCounts(counts: Record<string, number>): void {
    let total = 0;
    for (const [k, v] of Object.entries(counts)) {
      if (v > this.opts.perPlaceholderMax) {
        throw new Error(
          `substitution_limit_exceeded: per-placeholder for ${k}`,
        );
      }
      total += v;
    }
    if (total > this.opts.totalMax) {
      throw new Error('substitution_limit_exceeded: total');
    }
  }

  validatePosition(
    position: 'header' | 'body',
    allowed: ReadonlyArray<'header' | 'body'>,
  ): void {
    if (!allowed.includes(position)) {
      throw new Error(`substitution_position_disallowed: ${position}`);
    }
  }
}
