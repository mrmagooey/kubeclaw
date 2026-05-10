import { parseXfccSpiffeId } from './spiffe.js';

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
  /** When set, bearer-path tokens from other namespaces are rejected. */
  namespace?: string;
}

export interface VerifyInput {
  /** Raw Authorization header value (bearer path). */
  authorization?: string;
  /** Raw x-forwarded-client-cert header value (SPIFFE/XFCC path). */
  xfcc?: string;
}

export class IdentityVerifier {
  constructor(private readonly opts: IdentityVerifierOpts) {}

  /**
   * Verify caller identity and return it as "sa/<serviceAccountName>".
   *
   * Dispatch order:
   *   1. If xfcc is present: parse SPIFFE URI from the XFCC header.
   *   2. Else if authorization is present: call the TokenReview API.
   *   3. Both absent: throw "no credentials".
   */
  async verify(input: VerifyInput): Promise<string> {
    if (input.xfcc) {
      return parseXfccSpiffeId(input.xfcc);
    }

    if (input.authorization) {
      return this.verifyBearer(input.authorization);
    }

    throw new Error('no credentials: both authorization and xfcc are absent');
  }

  private async verifyBearer(authorizationHeader: string): Promise<string> {
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
