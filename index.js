/**
 * keenable_search — Host half.
 *
 * Registers one tool, `keenable_search`, that gives every Agent in this profile
 * web search through the Keenable API. Search is a Host-level capability, so a
 * single registration makes it available to every session and workspace; there
 * is nothing to copy per project.
 *
 * Why a separate plugin rather than a feature of dsh-session-suite: that bundle
 * is loaded into every session and already owns checkpoints, memory and sharing.
 * Network I/O that can time out has no business sharing a failure domain with
 * them, and a search change should not require republishing a 3000-line suite.
 *
 * Only `node:` builtins are imported. A bundle installed into a profile resolves
 * from the profile, not from the DSH installation, so `@deepseek-ai/*` runtime
 * packages would not resolve here.
 */

import { DEFAULT_TIMEOUT_MS, resolveCredentials, search, fetchPage } from './lib/keenable.js'

export const name = 'keenable-search'

/**
 * `tools` MUST be injected.
 *
 * The first version declared `inject = []` on the assumption that the tool
 * registry is reachable with `ctx.get('tools')` without declaring it. Measured
 * on DSH 0.2.2-rc.1 that assumption is false: the plugin row loaded
 * (`fiberPhase: "active"`) but `ctx.get('tools')` returned undefined, so
 * `apply()` took its fail-soft `return` and registered NOTHING. The plugin
 * looked installed, `plugin_manager` showed it active, yet the agent's tool
 * list never contained `keenable_search` / `keenable_fetch` — the model kept
 * calling the built-in `web_search`, which fails for lack of DEEPSEEK_API_KEY.
 *
 * Every other tool-providing plugin in this profile declares it:
 *   @restregular/dsh-computer-use  inject = ['tools']
 *   @ninkch/dsh-infinite-canvas    inject = ['webServer', 'tools']
 *
 * `connection` is deliberately NOT injected: this plugin registers no HTTP
 * route and must not be able to take the Host down by depending on something
 * it does not use. There is also no timer — an earlier plugin in this profile
 * crashed the Host with a polling interval on a context that had not injected
 * `timer`; nothing here needs one.
 */
export const inject = ['tools']

/** @param {any} ctx plugin context @param {any} [config] row config */
export function apply(ctx, config = {}) {
  const log = (message, error) => {
    if (error) ctx.logger?.warn?.(`[keenable-search] ${message}`, error)
    else ctx.logger?.info?.(`[keenable-search] ${message}`)
  }

  const tools = ctx.get('tools')
  if (!tools?.register) {
    // A profile without the tools service is not an error worth throwing over:
    // fail soft so the bundle still loads and the profile stays usable.
    log('tools service unavailable; keenable_search not registered')
    return
  }

  const timeoutMs = Number(config?.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS
  const maxResults = Number(config?.maxResults) > 0 ? Number(config.maxResults) : 8

  const credentials = () => resolveCredentials(config)

  /**
   * Render one search result set as compact text.
   *
   * Numbered so the model can refer to "source 2" without re-quoting a URL, and
   * the snippet is single-line because a multi-line snippet inside a numbered
   * list reads as separate results.
   *
   * @param {any[]} results search results
   * @returns {string} rendered text
   */
  const renderSearch = (results) =>
    results
      .map((r, i) => {
        const head = `[${i + 1}] ${r.title}`
        const lines = [head, `    ${r.url}`]
        if (r.snippet) lines.push('    ' + r.snippet.replace(/\s+/g, ' ').slice(0, 400))
        if (r.publishedAt) lines.push(`    published: ${r.publishedAt}`)
        return lines.join('\n')
      })
      .join('\n')

  // Registration is wrapped in try/catch for two reasons: `tools.register`
  // throws when the definition is malformed (a missing `output` descriptor took
  // a whole bundle down once), and an exception escaping `apply` marks the plugin
  // row `fiberPhase: "failed"`, which in this profile means the tool silently
  // disappears instead of reporting why.
  ctx.effect(() => {
    try {
      return tools.register({
        name: 'keenable_search',
        description: [
          'Search the live web and get back ranked results with titles, URLs and snippets.',
          '',
          'Use this when the answer depends on something you cannot verify from the',
          'conversation or the filesystem: current versions, recent releases, error',
          'messages from a library you do not have locally, documentation, prices,',
          'news, or "what changed in X". Do NOT use it for facts already in context.',
          '',
          'PASS SEVERAL QUERIES when the topic is broad: 1 to 4 queries are run and',
          'merged, and a second wording often finds what the first missed. Prefer',
          'concrete nouns and version numbers over full sentences.',
          '',
          'Filters exist and are worth using: `site` restricts to one domain (docs, a',
          'specific repo); `publishedAfter` / `publishedBefore` bound the publish date;',
          '`acquiredAfter` bounds the index date; `maxResults` up to 50.',
          '',
          'Every result carries a real URL. When you use a result, cite it as a',
          'markdown link. Snippets are excerpts, not full pages: call the tool again',
          'with a narrower query, or use `keenable_fetch` for one page, before you',
          'claim what a page says.',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            queries: {
              type: 'array',
              items: { type: 'string' },
              description: '1-4 search queries; results are merged in order.',
            },
            site: {
              type: 'string',
              description: 'Restrict to one domain, e.g. "github.com" or "docs.python.org".',
            },
            publishedAfter: {
              type: 'string',
              description: 'Only results published after this date (YYYY-MM-DD, ISO 8601, or a relative form like "7d").',
            },
            publishedBefore: {
              type: 'string',
              description: 'Only results published before this date.',
            },
            acquiredAfter: {
              type: 'string',
              description: 'Only results indexed after this date.',
            },
            maxResults: {
              type: 'integer',
              description: 'Results per query (default 8, max 50).',
            },
          },
          required: ['queries'],
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => {
            if (value?.error) return [{ type: 'text', text: `search failed: ${value.error}` }]
            const lines = []
            if (value?.warning) lines.push(`note: ${value.warning}`, '')
            for (const group of value?.groups ?? []) {
              lines.push(`## query: ${group.query}`)
              if (group.results?.length) lines.push(renderSearch(group.results))
              else lines.push('(no results)')
              lines.push('')
            }
            const text = lines.join('\n').trim()
            return [{ type: 'text', text: text || 'no results' }]
          },
        },
        async execute(args) {
          // A missing key is a configuration problem, not a search failure, and
          // the message has to say which so the fix is obvious.
          let creds
          try {
            creds = credentials()
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
          }
          if (!creds) {
            return {
              error:
                'KEENABLE_API_KEY is not set. Put it in the DSH environment (.env) or in this plugin row config as `apiKey`.',
            }
          }

          const rawQueries = Array.isArray(args?.queries) ? args.queries : []
          const queries = rawQueries
            .map((q) => String(q ?? '').trim())
            .filter(Boolean)
            .slice(0, 4)
          if (queries.length === 0) return { error: 'queries must contain at least one non-empty string' }

          const groups = []
          const seen = new Set()
          let warning
          let firstError

          // Queries run in sequence, not in parallel: the API is rate limited per
          // key and four simultaneous requests is the fastest way to trip it.
          for (const query of queries) {
            const result = await search(
              {
                query,
                maxResults: args?.maxResults ?? maxResults,
                site: args?.site,
                publishedAfter: args?.publishedAfter,
                publishedBefore: args?.publishedBefore,
                acquiredAfter: args?.acquiredAfter,
              },
              creds,
              { timeoutMs },
            )
            if (!result.ok) {
              firstError = firstError ?? `${result.code}: ${result.error}`
              groups.push({ query, results: [], error: `${result.code}: ${result.error}` })
              continue
            }
            if (result.warning) warning = result.warning
            // Merge-visible de-duplication: the same page often ranks for two
            // related queries, and showing it twice wastes the caller's attention.
            const fresh = result.results.filter((r) => {
              if (seen.has(r.url)) return false
              seen.add(r.url)
              return true
            })
            groups.push({ query, results: fresh })
          }

          // If every query failed, report the failure instead of an empty result
          // set that reads like "the web has nothing on this".
          if (groups.every((g) => g.error)) return { error: firstError ?? 'all queries failed' }
          const out = { groups, total: groups.reduce((n, g) => n + g.results.length, 0) }
          if (warning) out.warning = warning
          return out
        },
      })
    } catch (error) {
      log('failed to register keenable_search', error)
    }
  })

  // A second tool for reading one page in full. Kept separate because it costs a
  // request per call and most searches do not need it.
  ctx.effect(() => {
    try {
      return tools.register({
        name: 'keenable_fetch',
        description: [
          'Fetch one web page as readable text.',
          '',
          'Use this after a search when a snippet is not enough — to confirm what a',
          'page actually says before quoting it, or to read documentation in full.',
          'Give the exact URL a search result returned.',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Absolute http(s) URL.' },
            maxChars: { type: 'integer', description: 'Maximum characters to return (default 8000).' },
            live: { type: 'boolean', description: 'Fetch live content instead of the cached copy.' },
          },
          required: ['url'],
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => {
            if (value?.error) return [{ type: 'text', text: `fetch failed: ${value.error}` }]
            const body = String(value?.content ?? '').trim()
            return [{ type: 'text', text: body ? `${value.url}\n\n${body}` : `${value.url}\n\n(empty page)` }]
          },
        },
        async execute(args) {
          let creds
          try {
            creds = credentials()
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
          }
          if (!creds) {
            return {
              error:
                'KEENABLE_API_KEY is not set. Put it in the DSH environment (.env) or in this plugin row config as `apiKey`.',
            }
          }
          const result = await fetchPage(
            { url: args?.url, maxChars: args?.maxChars, live: args?.live === true },
            creds,
            { timeoutMs },
          )
          return result
        },
      })
    } catch (error) {
      log('failed to register keenable_fetch', error)
    }
  })

  log(`registered keenable_search and keenable_fetch (credential source: ${credentials()?.source ?? 'none'})`)
}
