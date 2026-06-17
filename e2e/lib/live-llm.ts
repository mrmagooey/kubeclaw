/**
 * Shared helpers for e2e tests that depend on a live LLM provider.
 *
 * Usage:
 *   import { LIVE_BASE_URL, LIVE_MODEL, LIVE_API_KEY, probeLiveLlm }
 *     from './lib/live-llm.js';
 *
 * Override via environment variables:
 *   LIVE_LLM_BASE_URL   (default: http://localhost:11434/v1  — Ollama default)
 *   LIVE_LLM_MODEL      (default: gemma-4-E4B-it-Q4_0.gguf)
 *   LIVE_LLM_API_KEY    (default: no-key)
 *
 * If the endpoint is unreachable, probeLiveLlm() emits a console.warn with
 * instructions so test-skip reasons are never silent.
 */

export const LIVE_BASE_URL: string =
  process.env.LIVE_LLM_BASE_URL ?? 'http://localhost:11434/v1';

export const LIVE_MODEL: string =
  process.env.LIVE_LLM_MODEL ?? 'gemma-4-E4B-it-Q4_0.gguf';

export const LIVE_API_KEY: string =
  process.env.LIVE_LLM_API_KEY ?? 'no-key';

/** Result returned by probeLiveLlm(). */
export interface LlmProbeResult {
  ok: boolean;
  reason: string;
}

/**
 * Probes the live LLM provider. Calls GET /models; if the env var is unset or
 * the endpoint is unreachable, emits a console.warn with instructions.
 *
 * Designed to be called at module load via top-level await so that
 * it.skipIf() receives the correct value before test definitions run.
 *
 * @param extraCheck  Optional second probe (e.g. POST /chat/completions).
 *                    Receives the base URL and API key; must return
 *                    { ok, reason }.
 */
export async function probeLiveLlm(
  extraCheck?: (baseUrl: string, apiKey: string) => Promise<LlmProbeResult>,
): Promise<LlmProbeResult> {
  try {
    const modelsRes = await fetch(`${LIVE_BASE_URL}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!modelsRes.ok) {
      const result: LlmProbeResult = {
        ok: false,
        reason: `GET /models returned HTTP ${modelsRes.status}`,
      };
      warnUnreachable(result.reason);
      return result;
    }

    if (extraCheck) {
      const extra = await extraCheck(LIVE_BASE_URL, LIVE_API_KEY);
      if (!extra.ok) {
        warnUnreachable(extra.reason);
        return extra;
      }
    }

    return { ok: true, reason: '' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnUnreachable(reason);
    return { ok: false, reason };
  }
}

function warnUnreachable(reason: string): void {
  console.warn(
    `\n⚠️  Live LLM provider at ${LIVE_BASE_URL} is unreachable: ${reason}\n` +
    `   Tests that require a live LLM will be skipped.\n` +
    `   To enable them, start an OpenAI-compatible LLM server and set:\n` +
    `     LIVE_LLM_BASE_URL=http://<host>:<port>/v1\n` +
    `   e.g. with Ollama:  ollama serve   (uses http://localhost:11434/v1)\n`,
  );
}
