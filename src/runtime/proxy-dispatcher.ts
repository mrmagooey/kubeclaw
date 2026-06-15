import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import { logger } from '../logger.js';

/**
 * When the credential sidecar sets HTTP(S)_PROXY, Node's global `fetch` does NOT
 * honor it by default. Install undici's EnvHttpProxyAgent as the global dispatcher
 * so all `fetch` egress (incl. the LLM SDK + pi-ai) routes through the in-pod Envoy,
 * which stamps broker credentials. EnvHttpProxyAgent honors NO_PROXY, so in-cluster
 * destinations listed there go direct. No-op when no proxy env is set (e.g. istio
 * mode is transparent, or injection is off).
 */
export function installProxyDispatcher(): void {
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    logger.info(
      { noProxy: process.env.NO_PROXY },
      'installed EnvHttpProxyAgent global dispatcher (egress via credential sidecar)',
    );
  }
}
