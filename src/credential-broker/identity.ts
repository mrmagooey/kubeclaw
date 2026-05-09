export interface TokenReviewStatus {
  authenticated: boolean;
  user?: { username?: string };
  error?: string;
}
export interface TokenReviewResponse {
  status: TokenReviewStatus;
}

export interface IdentityVerifierOpts {
  createTokenReview: (
    token: string,
    audiences: string[],
  ) => Promise<TokenReviewResponse>;
  audience: string;
  namespace?: string;
}

export class IdentityVerifier {
  constructor(private readonly opts: IdentityVerifierOpts) {}

  async verify(authorizationHeader: string | undefined): Promise<string> {
    if (!authorizationHeader) throw new Error('missing Authorization header');
    if (!authorizationHeader.startsWith('Bearer ')) {
      throw new Error('Authorization header must use Bearer scheme');
    }
    const token = authorizationHeader.slice('Bearer '.length).trimStart();
    const review = await this.opts.createTokenReview(token, [
      this.opts.audience,
    ]);
    if (!review.status.authenticated) {
      throw new Error(
        `token not authenticated: ${review.status.error ?? 'unknown'}`,
      );
    }
    const username = review.status.user?.username ?? '';
    const m = username.match(/^system:serviceaccount:([^:]+):(.+)$/);
    if (!m) throw new Error(`unexpected username format: ${username}`);
    const [, ns, sa] = m;
    if (this.opts.namespace && ns !== this.opts.namespace) {
      throw new Error(
        `token from namespace ${ns}, expected ${this.opts.namespace}`,
      );
    }
    return `sa/${sa}`;
  }
}
