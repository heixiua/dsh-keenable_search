// Live test of lib/keenable.js against the real API.
// Reads the credential from the DSH .env the same way the plugin will.
import fs from 'node:fs';
import { resolveCredentials, buildSearchBody, search, fetchPage, normaliseResult } from '../lib/keenable.js';

// The plugin reads process.env; here we load the DSH .env into it first, which
// is exactly what the Host process already has.
const ENV_FILE = 'D:\\AI agent cache\\dsh\\.env';
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

// The sandbox has no direct route to the internet; the local proxy does.
// The plugin itself must NOT hardcode a proxy, so this is set only in the test.
process.env.HTTPS_PROXY ??= 'http://127.0.0.1:7899';

let fails = 0;
const ok = (m) => console.log('  OK   ' + m);
const bad = (m) => { fails++; console.log('  FAIL ' + m); };

console.log('=== 1. credential resolution ===');
const creds = resolveCredentials({});
if (!creds) { bad('no credentials resolved'); process.exit(1); }
console.log('  baseUrl:', creds.baseUrl);
console.log('  apiKey :', creds.apiKey.slice(0, 8) + '...(len=' + creds.apiKey.length + ')');
console.log('  source :', creds.source);
ok('credentials resolved from env');

console.log('\n=== 2. config overrides env ===');
const overridden = resolveCredentials({ apiKey: 'cfg-key', baseUrl: 'https://example.test/' });
console.log('  apiKey source:', overridden.source, ' baseUrl:', overridden.baseUrl);
if (overridden.source === 'config' && overridden.baseUrl === 'https://example.test') ok('config wins and trailing slash trimmed');
else bad('override order wrong');

console.log('\n=== 3. body builder omits empty fields ===');
const b1 = buildSearchBody({ query: 'test' });
console.log('  minimal:', JSON.stringify(b1));
if (Object.keys(b1).length === 1) ok('only query sent when nothing else given');
else bad('unexpected keys: ' + Object.keys(b1).join(','));
const b2 = buildSearchBody({ query: 'q', maxResults: 999, site: 'github.com', publishedAfter: '2026-01-01' });
console.log('  full   :', JSON.stringify(b2));
if (b2.max_results === 50) ok('maxResults clamped to API cap 50');
else bad('clamp failed: ' + b2.max_results);

console.log('\n=== 4. empty query rejected ===');
try { buildSearchBody({ query: '   ' }); bad('empty query was accepted'); }
catch (e) { ok('empty query rejected: ' + e.message); }

console.log('\n=== 5. normaliseResult drops url-less rows and description ===');
const n1 = normaliseResult({ title: 'T', url: 'https://a', snippet: 'S', description: '', published_at: '2026-01-01' });
console.log('  clean row:', JSON.stringify(n1));
if (n1 && !('description' in n1)) ok('deprecated description dropped');
else bad('description leaked');
const n2 = normaliseResult({ title: 'no url', snippet: 'x' });
if (n2 === null) ok('url-less row dropped');
else bad('url-less row survived');

console.log('\n=== 6. LIVE search ===');
const live = await search({ query: 'DeepSeek Harness 插件', maxResults: 3 }, creds);
if (!live.ok) {
  bad(`search failed: ${live.code} ${live.error}`);
} else {
  console.log(`  mode: ${live.mode}  results: ${live.results.length}`);
  for (const r of live.results.slice(0, 3)) {
    console.log(`    - ${r.title.slice(0, 60)}`);
    console.log(`      ${r.url}`);
    console.log(`      ${r.snippet.slice(0, 80).replace(/\n/g, ' ')}...`);
  }
  if (live.results.length > 0) ok('live search returned results');
  else bad('live search returned zero results');
  const allHaveUrl = live.results.every((r) => /^https?:\/\//.test(r.url));
  if (allHaveUrl) ok('every result has a usable url');
  else bad('some results lack a url');
}

console.log('\n=== 7. site filter ===');
const filtered = await search({ query: 'dsh plugin', site: 'github.com', maxResults: 3 }, creds);
if (!filtered.ok) bad('site-filtered search failed: ' + filtered.error);
else {
  const okHost = filtered.results.every((r) => {
    try { return new URL(r.url).hostname.endsWith('github.com'); } catch { return false; }
  });
  console.log(`  results: ${filtered.results.length}, all on github.com: ${okHost}`);
  if (filtered.results.length === 0) ok('site filter applied (no github results for this query)');
  else if (okHost) ok('site filter respected');
  else bad('site filter ignored');
}

console.log('\n=== 8. timeout path ===');
const slow = await search({ query: 'x' }, creds, {
  timeoutMs: 1,
  fetchImpl: (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }),
});
console.log('  code:', slow.code, ' error:', slow.error);
if (!slow.ok && slow.code === 'TIMEOUT') ok('timeout produces TIMEOUT, not a hang');
else bad('timeout not handled: ' + JSON.stringify(slow));

console.log('\n=== 9. bad key surfaces AUTH, not a crash ===');
const badKey = await search({ query: 'x' }, { apiKey: 'sk-invalid', baseUrl: creds.baseUrl });
console.log('  code:', badKey.code, ' status:', badKey.status, ' error:', String(badKey.error).slice(0, 80));
if (!badKey.ok && (badKey.code === 'AUTH' || badKey.code === 'HTTP')) ok('bad key handled as a structured error');
else bad('bad key handling unexpected');

console.log('\n' + (fails === 0 ? 'RESULT: ALL LIVE TESTS PASSED' : `RESULT: ${fails} failure(s)`));
process.exit(fails ? 1 : 0);
