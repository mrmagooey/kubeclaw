import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';

/**
 * When the credential sidecar sets HTTP(S)_PROXY, Node's global `fetch` does NOT
 * honor it by default. Install undici's EnvHttpProxyAgent as the global dispatcher
 * so all `fetch` egress routes through the in-pod Envoy, which stamps broker
 * credentials. EnvHttpProxyAgent honors NO_PROXY, so in-cluster destinations
 * listed there go direct. No-op when no proxy env is set.
 */
export function installProxyDispatcher(): void {
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
}
