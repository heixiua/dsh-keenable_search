/**
 * Keenable search client.
 *
 * A thin, dependency-free wrapper over the Keenable web search API. Uses only
 * `node:` builtins so the bundle resolves from the profile it is installed into
 * (a profile-installed bundle cannot import @deepseek-ai runtime packages).
 *
 * The API surface used here was read from the service's own OpenAPI document at
 * `<base>/openapi.json` (v0.1.25), which declares:
 *
 *   POST /v1/search        Search the web
 *   GET  /v1/fetch         Fetch page content
 *   GET  /v1/auth/user     Get API key identity
 *
 * SearchRequest fields (all optional except `query`):
 *   query               string   required
 *   mode                "pro" | "realtime"
 *   max_results         integer  default 10, max 50
 *   snippet_max_length  integer  max 10000
 *   site                string   restrict to one domain
 *   published_after     string   lower bound on publish time
 *   published_before    string   upper bound on publish time
 *   acquired_after      string   lower bound on index time
 *   acquired_before     string   upper bound on index time
 *   query_time          string   point-in-time search
 *   enable_wizards      boolean  experimental, pro mode only
 *
 * The response carries `results[]` with title / url / snippet / published_at /
 * acquired_at. `description` is documented as deprecated and always empty, so it
 * is not surfaced.
 *
 * Everything here fails soft: a network or API problem returns a structured
 * error object rather than throwing into the agent loop. The tool wrapper still
 * decides whether to surface that as a failed tool call.
 */

/** How long one search request may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 15000

/** The API caps a single response at this many results. */
export const MAX_RESULTS_CAP = 50

/**
 * Read the Keenable credential and endpoint.
 *
 * Deliberately reads the environment rather than a file inside the plugin: the
 * key already lives in the DSH `.env`, and copying it into a second location
 * would create a second thing to leak and a second thing to keep in sync.
 *
 * @param {any} config row config from cordis.patch.yml
 * @param {NodeJS.ProcessEnv} [env] environment
 * @returns {{ apiKey: string, baseUrl: string, source: string } | null}
 */
export function resolveCredentials(config = {}, env = process.env) {
  const cfgKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : ''
  const cfgUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : ''

  // Resolution order: explicit config, then the environment. Config first so a
  // profile can override a machine-wide .env without editing that file.
  const apiKey = cfgKey || String(env.KEENABLE_API_KEY ?? '').trim()
  const baseUrl = cfgUrl || String(env.KEENABLE_API_URL ?? '').trim() || 'https://api.keenable.ai'
  if (!apiKey) return null
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    source: cfgKey ? 'config' : 'env',
  }
}

/**
 * Clamp a value into an inclusive integer range.
 *
 * @param {unknown} value raw input
 * @param {number} min lower bound
 * @param {number} max upper bound
 * @param {number} fallback used when the input is not a finite number
 * @returns {number} clamped integer
 */
function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

/**
 * Build the JSON body for one search call.
 *
 * Undefined fields are omitted rather than sent as null: the API rejects unknown
 * parameters (it answered `Unknown parameter(s): count` with the full supported
 * list), so sending an empty string where it expects a date would be worse than
 * sending nothing.
 *
 * @param {{ query: string, mode?: string, maxResults?: number, site?: string,
 *   publishedAfter?: string, publishedBefore?: string, acquiredAfter?: string,
 *   acquiredBefore?: string, queryTime?: string, snippetMaxLength?: number }} input
 * @returns {Record<string, unknown>} request body
 */
export function buildSearchBody(input = {}) {
  const query = String(input.query ?? '').trim()
  if (!query) throw new Error('query is required')

  const body = { query }
  if (input.mode === 'realtime' || input.mode === 'pro') body.mode = input.mode
  if (input.maxResults !== undefined) {
    body.max_results = clampInt(input.maxResults, 1, MAX_RESULTS_CAP, 10)
  }
  if (input.snippetMaxLength !== undefined) {
    body.snippet_max_length = clampInt(input.snippetMaxLength, 1, 10000, 600)
  }
  for (const [from, to] of [
    ['site', 'site'],
    ['publishedAfter', 'published_after'],
    ['publishedBefore', 'published_before'],
    ['acquiredAfter', 'acquired_after'],
    ['acquiredBefore', 'acquired_before'],
    ['queryTime', 'query_time'],
  ]) {
    const value = input[from]
    if (typeof value === 'string' && value.trim()) body[to] = value.trim()
  }
  return body
}

/**
 * Normalise one raw result into the shape the tool returns.
 *
 * `description` is dropped: the API documents it as deprecated and always empty.
 * A result with no URL is dropped entirely, because a citation the caller cannot
 * open is worse than no citation.
 *
 * @param {any} raw API result
 * @returns {{ title: string, url: string, snippet: string, publishedAt?: string, acquiredAt?: string } | null}
 */
export function normaliseResult(raw) {
  if (!raw || typeof raw !== 'object') return null
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (!url) return null
  const out = {
    title: String(raw.title ?? '').trim() || url,
    url,
    snippet: String(raw.snippet ?? '').trim(),
  }
  if (typeof raw.published_at === 'string' && raw.published_at) out.publishedAt = raw.published_at
  if (typeof raw.acquired_at === 'string' && raw.acquired_at) out.acquiredAt = raw.acquired_at
  return out
}

/**
 * Perform one search request.
 *
 * @param {object} input search input, see buildSearchBody
 * @param {{ apiKey: string, baseUrl: string }} credentials resolved credentials
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options] injection seams for tests
 * @returns {Promise<{ ok: true, query: string, mode: string, results: any[], warning?: string } |
 *   { ok: false, error: string, code: string, status?: number }>} result or structured failure
 */
export async function search(input, credentials, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? globalThis.fetch

  let body
  try {
    body = buildSearchBody(input)
  } catch (error) {
    // A caller mistake (empty query) is not a network failure; report it the same
    // way so the tool has one error shape to render.
    return { ok: false, code: 'BAD_INPUT', error: error instanceof Error ? error.message : String(error) }
  }
  if (typeof doFetch !== 'function') {
    return { ok: false, code: 'NO_FETCH', error: 'fetch is not available in this runtime' }
  }

  // AbortSignal.timeout is the whole reason this can hang for 15s instead of
  // forever; a stuck tool call blocks the agent turn.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await doFetch(`${credentials.baseUrl}/v1/search`, {
      method: 'POST',
      headers: {
        // Both auth styles are declared by the API; bearer is used here because
        // it is also what the curl probes succeeded with.
        authorization: `Bearer ${credentials.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const text = await response.text()
    let parsed
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      return {
        ok: false,
        code: 'BAD_JSON',
        status: response.status,
        error: `search returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
      }
    }

    if (!response.ok) {
      const message = parsed?.message ?? parsed?.error ?? `HTTP ${response.status}`
      return {
        ok: false,
        code: response.status === 401 || response.status === 403 ? 'AUTH' : 'HTTP',
        status: response.status,
        error: String(message),
      }
    }

    const results = Array.isArray(parsed?.results)
      ? parsed.results.map(normaliseResult).filter(Boolean)
      : []
    const out = {
      ok: true,
      query: String(parsed?.query ?? body.query),
      mode: String(parsed?.mode ?? body.mode ?? 'pro'),
      results,
    }
    // `warning` appears when the request was not answered as a plain search
    // (documented in the OpenAPI schema); surfacing it beats silently returning
    // fewer results than asked for.
    if (typeof parsed?.warning === 'string' && parsed.warning) out.warning = parsed.warning
    return out
  } catch (error) {
    const aborted = controller.signal.aborted
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'NETWORK',
      error: aborted
        ? `search timed out after ${timeoutMs}ms`
        : `search failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch one page's readable text.
 *
 * Kept separate from search because it costs a second request and most calls do
 * not need it. `maxChars` maps to the API's `max_chars`.
 *
 * @param {{ url: string, maxChars?: number, live?: boolean }} input fetch input
 * @param {{ apiKey: string, baseUrl: string }} credentials resolved credentials
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options] injection seams
 * @returns {Promise<{ ok: true, url: string, content: string } | { ok: false, error: string, code: string, status?: number }>}
 */
export async function fetchPage(input, credentials, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const url = String(input?.url ?? '').trim()
  if (!url) return { ok: false, code: 'BAD_INPUT', error: 'url is required' }
  if (typeof doFetch !== 'function') return { ok: false, code: 'NO_FETCH', error: 'fetch is not available' }

  const params = new URLSearchParams({ url })
  if (input.maxChars !== undefined) params.set('max_chars', String(clampInt(input.maxChars, 1, 100000, 8000)))
  if (input.live === true) params.set('live', 'true')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await doFetch(`${credentials.baseUrl}/v1/fetch?${params.toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${credentials.apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      return { ok: false, code: 'BAD_JSON', status: response.status, error: `fetch returned non-JSON (HTTP ${response.status})` }
    }
    if (!response.ok) {
      return {
        ok: false,
        code: response.status === 401 || response.status === 403 ? 'AUTH' : 'HTTP',
        status: response.status,
        error: String(parsed?.message ?? parsed?.error ?? `HTTP ${response.status}`),
      }
    }
    // The documented field name is not pinned down by the OpenAPI excerpt we have,
    // so accept the plausible shapes rather than assuming one.
    const content =
      typeof parsed?.content === 'string'
        ? parsed.content
        : typeof parsed?.text === 'string'
          ? parsed.text
          : typeof parsed?.data === 'string'
            ? parsed.data
            : ''
    return { ok: true, url: String(parsed?.url ?? url), content }
  } catch (error) {
    const aborted = controller.signal.aborted
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'NETWORK',
      error: aborted ? `fetch timed out after ${timeoutMs}ms` : `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
