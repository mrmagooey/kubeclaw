import { parseXfccSpiffeId } from './spiffe.js';
import { PodInformer } from './pod-informer.js';

export interface TokenReviewStatus {
  authenticated: boolean;
  user?: { username?: string; extra?: Record<string, string[]> };
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
  /** When set, enables resolveOwnerGroup() for sidecar and istio paths. */
  podInformer?: PodInformer;
}

export interface VerifyInput {
  /** Raw Authorization header value (bearer path). */
  authorization?: string;
  /** Raw x-forwarded-client-cert header value (SPIFFE/XFCC path). */
  xfcc?: string;
}

export interface OwnerGroupVerifyInput extends VerifyInput {
  /** Source IP of the request (populated by ext_authz envelope in istio mode). */
  sourceIP?: string;
}

export interface IdentityWithOwnerGroup {
  identity: string;
  ownerGroup: string | null;
  podUid: string | null;
}

/** Result of a successful bearer token review, including raw review data. */
interface BearerReviewResult {
  identity: string;
  review: TokenReviewResponse;
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
      const { identity } = await this.performTokenReview(input.authorization);
      return identity;
    }

    throw new Error('no credentials: both authorization and xfcc are absent');
  }

  /**
   * Verify caller identity and resolve the ownerGroup from the pod annotation.
   *
   * Requires podInformer in opts. If not configured, returns ownerGroup: null.
   *
   * Sidecar path: uses pod-uid from TokenReview extras.
   * Istio path: uses sourceIP to look up the pod.
   */
  async resolveOwnerGroup(
    input: OwnerGroupVerifyInput,
  ): Promise<IdentityWithOwnerGroup> {
    if (!this.opts.podInformer) {
      const identity = await this.verify(input);
      return { identity, ownerGroup: null, podUid: null };
    }

    // Sidecar path: bearer token present — do a single TokenReview and extract extras
    if (input.authorization) {
      const { identity, review } = await this.performTokenReview(
        input.authorization,
      );
      const podUid =
        review.status.user?.extra?.[
          'authentication.kubernetes.io/pod-uid'
        ]?.[0] ?? null;
      if (podUid) {
        const r = this.opts.podInformer.resolveOwnerGroupByUID(podUid);
        return r
          ? { identity, ownerGroup: r.ownerGroup, podUid: r.podUid }
          : { identity, ownerGroup: null, podUid };
      }
      return { identity, ownerGroup: null, podUid };
    }

    // Istio path: XFCC + sourceIP
    if (input.xfcc) {
      const identity = parseXfccSpiffeId(input.xfcc);
      if (input.sourceIP) {
        const r = this.opts.podInformer.resolveOwnerGroupByIP(input.sourceIP);
        return r
          ? { identity, ownerGroup: r.ownerGroup, podUid: r.podUid }
          : { identity, ownerGroup: null, podUid: null };
      }
      return { identity, ownerGroup: null, podUid: null };
    }

    throw new Error('no credentials: both authorization and xfcc are absent');
  }

  /**
   * Perform a TokenReview for the given Authorization header and return
   * both the resolved identity string and the raw review response.
   * This avoids a double TokenReview call when callers need the extras.
   */
  private async performTokenReview(
    authorizationHeader: string,
  ): Promise<BearerReviewResult> {
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
    return { identity: `sa/${sa}`, review };
  }
}
