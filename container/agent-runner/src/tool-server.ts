/**
 * KubeClaw Tool Server
 * Alternative entrypoint for the tool container image.
 * Runs in a catalog sidecar tool pod (http/file/acp/cdp bridge mode) and executes tool calls
 * routed from the agent MCP server via Redis Streams.
 */

import fs from 'fs';
import path from 'path';
import { createClient, RedisClientType } from 'redis';
import { chromium, type Browser, type Page } from 'playwright-core';

const agentJobId = process.env.KUBECLAW_TOOL_JOB_ID!;
const category = process.env.KUBECLAW_CATEGORY as string;
const redisUrl = process.env.REDIS_URL || 'redis://kubeclaw-redis:6379';
const idleTimeout = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10);
const toolMode = process.env.KUBECLAW_TOOL_MODE as
  | 'http-bridge'
  | 'file-bridge'
  | 'acp-bridge'
  | 'cdp-bridge'
  | undefined;
const toolPort = parseInt(process.env.KUBECLAW_TOOL_PORT || '8080', 10);
const SHARED_DIR = process.env.KUBECLAW_SHARED_DIR || '/shared';
const MAX_TOOL_OUTPUT_BYTES = parseInt(
  process.env.KUBECLAW_MAX_TOOL_OUTPUT_BYTES || '50000',
  10,
);
const declaredFields = (process.env.KUBECLAW_TOOL_FIELDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TOOLCALLS_STREAM = `kubeclaw:toolcalls:${agentJobId}:${category}`;
const TOOLRESULTS_STREAM = `kubeclaw:toolresults:${agentJobId}:${category}`;

/**
 * Exponential reconnect backoff (ported from the legacy adapters):
 * min(2^retries * 100ms, 10s), giving up after 10 retries.
 */
export function reconnectStrategy(retries: number): number | Error {
  if (retries > 10) return new Error('Redis reconnect retries exhausted');
  return Math.min(Math.pow(2, retries) * 100, 10_000);
}

function log(msg: string): void {
  console.error(`[tool-server:${category}] ${msg}`);
}

/** Unrecoverable client error (HTTP 4xx) — do not retry. */
export class ToolClientError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`Tool HTTP ${status}: ${body}`);
    this.name = 'ToolClientError';
  }
}

const REQUEST_TIMEOUT_MS = parseInt(
  process.env.KUBECLAW_TOOL_REQUEST_TIMEOUT || '30000',
  10,
);
const RETRY_BASE_MS = parseInt(
  process.env.KUBECLAW_TOOL_RETRY_BASE_MS || '1000',
  10,
);
const RETRY_MAX_ATTEMPTS = 3;

/**
 * fetch with retry discipline:
 * - per-attempt timeout (AbortSignal)
 * - 4xx → ToolClientError, no retry (the request itself is wrong)
 * - 5xx / network error / timeout → exponential backoff (base×1 → base×2), 3 attempts max
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      log(
        `Retrying ${url} in ${delay}ms (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      const body = await res.text();
      if (res.status >= 400 && res.status < 500) {
        throw new ToolClientError(res.status, body);
      }
      lastError = new Error(`Tool HTTP ${res.status}: ${body}`);
    } catch (err) {
      if (err instanceof ToolClientError) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const READY_TIMEOUT_MS = parseInt(
  process.env.KUBECLAW_TOOL_READY_TIMEOUT || '30000',
  10,
);
const READY_INTERVAL_MS = parseInt(
  process.env.KUBECLAW_TOOL_READY_INTERVAL_MS || '1000',
  10,
);
const toolHealthPath = process.env.KUBECLAW_TOOL_HEALTH_PATH || '/';

/**
 * Poll the user container until it accepts an HTTP connection (ported from
 * the legacy adapter's waitForHealthy). ANY HTTP response — including 404 —
 * counts as ready: the contract is "the port is listening", because arbitrary
 * images may not expose a real health endpoint. Connection errors mean
 * not-ready; keep polling until the deadline.
 */
export async function waitForToolReady(): Promise<void> {
  const url = `http://localhost:${toolPort}${toolHealthPath}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      log(`User container ready (${url})`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
    }
  }
  throw new Error(
    `User container not ready after ${READY_TIMEOUT_MS}ms (${url})`,
  );
}

let readyPromise: Promise<void> | null = null;

/** Memoized readiness gate — applies to http-bridge and acp-bridge only. */
function ensureToolReady(): Promise<void> {
  if (toolMode !== 'http-bridge' && toolMode !== 'acp-bridge') {
    return Promise.resolve();
  }
  if (!readyPromise) {
    readyPromise = waitForToolReady().catch((err) => {
      readyPromise = null; // a later call may try again
      throw err;
    });
  }
  return readyPromise;
}

export interface BraveSearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
  source?: string;
}

export async function toolWebSearch(input: { query: string }): Promise<string> {
  const apiUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=10`;

  // In sidecar/istio mode the workload's HTTPS_PROXY routes through Envoy and
  // the broker stamps X-Subscription-Token via ext_authz — do NOT set the
  // header manually.  In mode=off read BRAVE_API_KEY directly.
  const key = process.env.BRAVE_API_KEY;
  const shouldSetHeader =
    !!key && !key.startsWith('KC_PH_') && key !== 'injected-by-broker';

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip',
  };
  if (shouldSetHeader) {
    headers['X-Subscription-Token'] = key!;
  }

  const res = await fetch(apiUrl, { headers });
  if (!res.ok) {
    throw new Error(
      `Brave Search API returned ${res.status}: ${await res.text()}`,
    );
  }

  const data = (await res.json()) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
        age?: string;
        meta_url?: { hostname?: string };
      }>;
    };
  };

  const results: BraveSearchResult[] = (data.web?.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
    published: r.age,
    source: r.meta_url?.hostname,
  }));

  return JSON.stringify(results);
}


// --- Request-mapping helpers ---

interface RequestMapping {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  responsePath?: string;
}

interface MappedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Resolve "{field}" tokens in a string against input; throws on a missing field. */
function substituteString(
  template: string,
  input: Record<string, unknown>,
): string {
  return template.replace(TOKEN_RE, (_m, field: string) => {
    if (!(field in input)) {
      throw new Error(`request mapping references missing field "${field}"`);
    }
    const v = input[field];
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** Like substituteString but URL-encodes each substituted token value, for use
 *  in URL path segments. Prevents a field value containing "/" or ".." from
 *  altering the request path (path-traversal / endpoint redirection). */
function substitutePathTokens(
  template: string,
  input: Record<string, unknown>,
): string {
  return template.replace(TOKEN_RE, (_m, field: string) => {
    if (!(field in input)) {
      throw new Error(`request mapping references missing field "${field}"`);
    }
    const v = input[field];
    return encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v));
  });
}

/** Substitute tokens inside a JSON body template. A string leaf exactly equal to
 *  "{field}" is replaced with the field's value preserving its JSON type; a leaf
 *  embedding a token in a larger string is string-interpolated. */
function substituteBody(
  node: unknown,
  input: Record<string, unknown>,
): unknown {
  if (typeof node === 'string') {
    const exact = node.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (exact) {
      const field = exact[1];
      if (!(field in input)) {
        throw new Error(`request mapping references missing field "${field}"`);
      }
      return input[field]; // preserve JSON type
    }
    return substituteString(node, input);
  }
  if (Array.isArray(node)) return node.map((n) => substituteBody(n, input));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node))
      out[k] = substituteBody(v, input);
    return out;
  }
  return node;
}

export function buildMappedRequest(
  mapping: RequestMapping,
  input: Record<string, unknown>,
  port: number,
): MappedRequest {
  const path = substitutePathTokens(mapping.path, input);
  const url = new URL(`http://localhost:${port}${path}`);
  if (mapping.query) {
    for (const [k, tmpl] of Object.entries(mapping.query)) {
      url.searchParams.set(k, substituteString(tmpl, input));
    }
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (mapping.headers) {
    for (const [k, tmpl] of Object.entries(mapping.headers)) {
      // strip CR/LF to prevent header injection
      headers[k] = substituteString(tmpl, input).replace(/[\r\n]/g, '');
    }
  }
  let body: string | undefined;
  if (mapping.body !== undefined) {
    body = JSON.stringify(substituteBody(mapping.body, input));
    headers['Content-Type'] = 'application/json';
  }
  return { url: url.toString(), method: mapping.method, headers, body };
}

export function extractResponsePath(
  bodyText: string,
  responsePath: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `responsePath "${responsePath}" requested but response body is not JSON: ${bodyText.slice(0, 120)}`,
    );
  }
  let cur: unknown = parsed;
  for (const seg of responsePath.split('.')) {
    if (
      cur &&
      typeof cur === 'object' &&
      Object.prototype.hasOwnProperty.call(cur, seg)
    ) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      throw new Error(
        `responsePath "${responsePath}" not found in response: ${bodyText.slice(0, 120)}`,
      );
    }
  }
  return typeof cur === 'string' ? cur : JSON.stringify(cur);
}

// --- Bridge modes ---

export async function executeToolBridgeHttp(
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  await ensureToolReady();

  const rawRequestMapping = process.env.KUBECLAW_TOOL_REQUEST_MAPPING;
  if (rawRequestMapping) {
    let mapping: RequestMapping;
    try {
      mapping = JSON.parse(rawRequestMapping) as RequestMapping;
    } catch (err) {
      throw new Error(
        `invalid KUBECLAW_TOOL_REQUEST_MAPPING: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const req = buildMappedRequest(mapping, input, toolPort);
    const res = await fetchWithRetry(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    const text = await res.text();
    const shaped = mapping.responsePath
      ? extractResponsePath(text, mapping.responsePath)
      : text;
    return shaped.slice(0, MAX_TOOL_OUTPUT_BYTES);
  }

  // Default contract: POST /invoke with {tool, input}
  const res = await fetchWithRetry(`http://localhost:${toolPort}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, input }),
  });
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (data.error) throw new Error(data.error);
  return data.result ?? null;
}

export async function executeToolBridgeFile(
  tool: string,
  input: Record<string, unknown>,
  requestId: string,
  declaredFields: string[],
): Promise<unknown> {
  const sharedDir = process.env.KUBECLAW_SHARED_DIR || SHARED_DIR;
  const reqDir = path.join(sharedDir, 'req', requestId);
  const respDir = path.join(sharedDir, 'resp', requestId);

  // Build the request under a hidden temp dir, then atomically rename into place.
  const tmpReq = path.join(sharedDir, `.req.${requestId}.tmp`);
  const tmpInput = path.join(tmpReq, 'input');
  fs.mkdirSync(tmpInput, { recursive: true });
  for (const field of declaredFields) {
    if (!(field in input)) continue; // omit fields the call didn't provide
    const v = input[field];
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    fs.writeFileSync(path.join(tmpInput, field), text);
  }
  fs.mkdirSync(path.join(sharedDir, 'req'), { recursive: true });
  fs.renameSync(tmpReq, reqDir); // atomic publish

  const deadline = Date.now() + idleTimeout;
  while (Date.now() < deadline) {
    if (fs.existsSync(respDir)) {
      let exit = '';
      let stdout = '';
      let stderr = '';
      try {
        exit = fs.readFileSync(path.join(respDir, 'exit_code'), 'utf-8').trim();
        stdout = fs.existsSync(path.join(respDir, 'response'))
          ? fs.readFileSync(path.join(respDir, 'response'), 'utf-8')
          : '';
        stderr = fs.existsSync(path.join(respDir, 'stderr'))
          ? fs.readFileSync(path.join(respDir, 'stderr'), 'utf-8')
          : '';
      } finally {
        fs.rmSync(respDir, { recursive: true, force: true });
      }
      if (exit !== '0') {
        throw new Error(
          `exit ${exit}: ${stderr.slice(0, MAX_TOOL_OUTPUT_BYTES)}`,
        );
      }
      return stdout.slice(0, MAX_TOOL_OUTPUT_BYTES);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('File bridge timeout');
}

// --- ACP bridge mode ---

const acpAgentName = process.env.KUBECLAW_ACP_AGENT_NAME;
const acpMode = process.env.KUBECLAW_ACP_MODE || 'sync';

async function executeToolBridgeAcp(
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  await ensureToolReady();
  const acpBaseUrl = `http://localhost:${toolPort}`;
  const agentName = acpAgentName || tool;

  // Convert tool input to ACP message format
  const taskText = (input.task as string) ?? JSON.stringify(input);
  const acpInput = [
    {
      role: 'user',
      parts: [{ content: taskText, content_type: 'text/plain' }],
    },
  ];

  if (acpMode === 'sync') {
    const res = await fetchWithRetry(
      `${acpBaseUrl}/runs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_name: agentName,
          input: acpInput,
          mode: 'synchronous',
        }),
      },
      idleTimeout,
    );
    return extractACPResult(await res.json());
  }

  // Async: POST /runs returns run_id, poll for result
  const createRes = await fetchWithRetry(`${acpBaseUrl}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_name: agentName, input: acpInput }),
  });
  const run = (await createRes.json()) as { run_id: string; status: string };

  // Poll with exponential backoff
  let delay = 500;
  const deadline = Date.now() + idleTimeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5000);

    // Intentionally plain fetch (no fetchWithRetry): the poll loop itself is
    // the retry mechanism, and retrying poll GETs would mis-handle terminal
    // states (e.g. a 404 after run cleanup would be retried as if transient).
    const pollRes = await fetch(`${acpBaseUrl}/runs/${run.run_id}`);
    if (!pollRes.ok) throw new Error(`ACP poll error: ${pollRes.status}`);
    const state = (await pollRes.json()) as {
      status: string;
      output?: unknown;
    };

    if (state.status === 'completed') return extractACPResult(state);
    if (state.status === 'failed') throw new Error('ACP agent run failed');
    if (state.status === 'cancelled')
      throw new Error('ACP agent run cancelled');
    if (state.status === 'awaiting') {
      return `ACP agent is awaiting input: ${JSON.stringify(state.output ?? 'additional information needed')}`;
    }
  }
  throw new Error('ACP agent timed out');
}

function extractACPResult(response: any): string {
  const output = response.output ?? response.result ?? [];
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .flatMap((msg: any) =>
        (msg.parts ?? [])
          .filter(
            (p: any) => !p.content_type || p.content_type === 'text/plain',
          )
          .map((p: any) => p.content),
      )
      .join('\n');
  }
  return JSON.stringify(output);
}

// --- CDP bridge ---

let cdpBrowser: Browser | null = null;
let cdpPage: Page | null = null;

async function getCdpPage(): Promise<Page> {
  const url = process.env.KUBECLAW_CDP_URL || 'http://localhost:9222';
  if (cdpBrowser?.isConnected() && cdpPage && !cdpPage.isClosed())
    return cdpPage;
  // Close a stale-but-connected browser before reconnecting (avoid CDP client leak).
  if (cdpBrowser) {
    await cdpBrowser.close().catch(() => {});
    cdpBrowser = null;
    cdpPage = null;
  }
  // Connect with retry/backoff — the chromium sidecar may still be starting; connectOverCDP
  // hits /json/version internally, so the connect itself is the readiness gate.
  const deadline = Date.now() + 30000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      cdpBrowser = await chromium.connectOverCDP(url);
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!cdpBrowser)
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  const ctx = cdpBrowser.contexts()[0] ?? (await cdpBrowser.newContext());
  cdpPage = ctx.pages()[0] ?? (await ctx.newPage());
  return cdpPage;
}

const SNAPSHOT_FN = `(() => {
  const SEL = ['a[href]','button:not([disabled])','input:not([disabled])','select:not([disabled])','textarea:not([disabled])','[role=button]','[role=link]','[role=checkbox]','[role=tab]','[role=menuitem]','[role=combobox]','[tabindex]:not([tabindex="-1"])','[onclick]'].join(',');
  document.querySelectorAll('[data-kc-ref]').forEach(e => e.removeAttribute('data-kc-ref'));
  let n = 0; const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-kc-ref', ref);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const text = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').trim().replace(/\\s+/g,' ').slice(0,80);
    out.push('[' + ref + '] ' + role + ' "' + text + '"');
  }
  return out.join('\\n');
})()`;

export async function executeToolBridgeCdp(
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const action = String(input.action ?? '');
  let page: Page;
  try {
    page = await getCdpPage();
  } catch (err) {
    return `error: cannot connect to browser (${err instanceof Error ? err.message : String(err)})`;
  }
  try {
    switch (action) {
      case 'navigate': {
        await page.goto(String(input.url ?? ''), {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        return `Navigated to ${page.url()} — "${await page.title()}"`;
      }
      case 'snapshot': {
        const elements = (await page.evaluate(SNAPSHOT_FN)) as string;
        const text = (await page.innerText('body').catch(() => ''))
          .replace(/\s+/g, ' ')
          .slice(0, 4000);
        const out = `URL: ${page.url()}\nTitle: ${await page.title()}\n\nInteractive elements:\n${elements}\n\nVisible text (truncated):\n${text}`;
        return out.slice(0, MAX_TOOL_OUTPUT_BYTES);
      }
      case 'click': {
        await page
          .locator(`[data-kc-ref="${String(input.ref ?? '')}"]`)
          .click({ timeout: 10000 });
        return `Clicked ${input.ref}`;
      }
      case 'type': {
        const loc = page.locator(`[data-kc-ref="${String(input.ref ?? '')}"]`);
        await loc.fill(String(input.text ?? ''), { timeout: 10000 });
        if (input.submit) await loc.press('Enter');
        return `Typed into ${input.ref}`;
      }
      case 'press': {
        await page.keyboard.press(String(input.key ?? ''));
        return `Pressed ${input.key}`;
      }
      case 'back': {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
        return `Back to ${page.url()}`;
      }
      case 'wait': {
        const f = String(input.for ?? '');
        if (/^\d+$/.test(f))
          await page.waitForTimeout(Math.min(Number(f), 30000));
        else await page.waitForSelector(f, { timeout: 30000 });
        return `Waited for ${f}`;
      }
      default:
        return `error: unknown action "${action}". Valid actions: navigate, snapshot, click, type, press, back, wait`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/data-kc-ref|no element|not found|Timeout.*locator/i.test(msg)) {
      return `error: element ${input.ref ?? ''} not found or not actionable — call snapshot first (${msg.slice(0, 200)})`;
    }
    return `error: ${msg.slice(0, 500)}`;
  }
}

// --- Tool dispatch ---

async function executeTool(
  tool: string,
  input: Record<string, unknown>,
  requestId: string,
): Promise<unknown> {
  if (toolMode === 'cdp-bridge') return executeToolBridgeCdp(tool, input);
  if (toolMode === 'acp-bridge') return executeToolBridgeAcp(tool, input);
  if (toolMode === 'http-bridge') return executeToolBridgeHttp(tool, input);
  if (toolMode === 'file-bridge')
    return executeToolBridgeFile(tool, input, requestId, declaredFields);
  throw new Error(
    `No tool bridge mode set (KUBECLAW_TOOL_MODE missing); tool=${tool}`,
  );
}

// --- Main loop ---

async function main(): Promise<void> {
  if (!agentJobId || (!category && !toolMode)) {
    log(
      'KUBECLAW_TOOL_JOB_ID and either KUBECLAW_CATEGORY or KUBECLAW_TOOL_MODE are required',
    );
    process.exit(1);
  }

  log(
    `Starting. agentJobId=${agentJobId} category=${category} toolMode=${toolMode ?? 'none'}`,
  );

  const redis = createClient({
    url: redisUrl,
    socket: { reconnectStrategy },
  }) as RedisClientType;
  redis.on('error', (err) => log(`Redis error: ${err.message}`));
  await redis.connect();
  log('Connected to Redis');

  let lastId = '0-0'; // process from beginning so pre-spawned calls are picked up
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log('Idle timeout reached, exiting');
      process.exit(0);
    }, idleTimeout);
  }

  resetIdleTimer();

  while (true) {
    try {
      const response = await redis.xRead(
        [{ key: TOOLCALLS_STREAM, id: lastId }],
        { BLOCK: Math.min(idleTimeout, 30000), COUNT: 1 },
      );

      if (!response || response.length === 0) continue;

      const streamData = response[0];
      if (!streamData?.messages?.length) continue;

      for (const message of streamData.messages) {
        lastId = message.id;
        resetIdleTimer();

        const fields = message.message as Record<string, string>;
        const requestId = fields.requestId;
        const tool = fields.tool;
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(fields.input || '{}');
        } catch {
          input = {};
        }

        log(`Executing tool=${tool} requestId=${requestId}`);

        let result: unknown;
        let error: string | undefined;
        try {
          result = await executeTool(tool, input, requestId);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          log(`Tool error: ${error}`);
        }

        await redis.xAdd(TOOLRESULTS_STREAM, '*', {
          requestId,
          result: JSON.stringify(result ?? null),
          ...(error ? { error } : {}),
        });
      }
    } catch (err) {
      log(
        `Stream read error: ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
