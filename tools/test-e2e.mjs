// End-to-end: drive the registered tools the way the Host will, with a real key.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Load the DSH .env into process.env, exactly as the Host already has it.
const ENV_FILE = 'D:\\AI agent cache\\dsh\\.env';
for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
// Test-only: the sandbox reaches the internet through the local proxy. The
// plugin itself never sets this.
process.env.HTTPS_PROXY ??= 'http://127.0.0.1:7899';

let fails = 0;
const ok = (m) => console.log('  OK   ' + m);
const bad = (m) => { fails++; console.log('  FAIL ' + m); };

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
const tools = {};
mod.apply({
  logger: { info: (m) => console.log('  [log] ' + m), warn: (m) => console.log('  [warn] ' + m) },
  get: (k) => (k === 'tools' ? { register: (d) => { tools[d.name] = d; return () => {}; } } : undefined),
  effect: (fn) => fn(),
}, { timeoutMs: 20000, maxResults: 5 });

console.log('\n=== 1. single query, real API ===');
const r1 = await tools.keenable_search.execute({ queries: ['DeepSeek Harness 长期记忆 插件'] });
if (r1?.error) { bad('error: ' + r1.error); }
else {
  console.log('  total results:', r1.total);
  for (const g of r1.groups) {
    console.log(`  query "${g.query}": ${g.results.length} result(s)`);
    for (const r of g.results.slice(0, 2)) console.log(`    - ${r.title.slice(0, 55)} | ${r.url}`);
  }
  if (r1.total > 0) ok('real search returned results');
  else bad('no results');
}

console.log('\n=== 2. rendered text (what the model actually sees) ===');
const rendered = tools.keenable_search.output.render({}, r1);
console.log(rendered[0].text.split('\n').slice(0, 12).map((l) => '    ' + l).join('\n'));
if (rendered[0].text.includes('## query:')) ok('render groups by query');
else bad('render missing query heading');
if (rendered[0].text.includes('https://')) ok('render includes URLs');
else bad('render dropped URLs');

console.log('\n=== 3. multiple queries merge with de-duplication ===');
const r2 = await tools.keenable_search.execute({
  queries: ['DeepSeek Harness plugin', 'DeepSeek Harness 插件'],
  maxResults: 4,
});
if (r2?.error) bad('error: ' + r2.error);
else {
  console.log('  groups:', r2.groups.length, ' total:', r2.total);
  const urls = r2.groups.flatMap((g) => g.results.map((r) => r.url));
  const unique = new Set(urls);
  console.log(`  urls: ${urls.length}  unique: ${unique.size}`);
  if (urls.length === unique.size) ok('no duplicate URLs across queries');
  else bad(`${urls.length - unique.size} duplicate URL(s) survived`);
  if (r2.groups.length === 2) ok('both queries reported');
  else bad('expected 2 groups');
}

console.log('\n=== 4. site filter end-to-end ===');
const r3 = await tools.keenable_search.execute({ queries: ['dsh plugin'], site: 'github.com', maxResults: 3 });
if (r3?.error) bad('error: ' + r3.error);
else {
  const hosts = r3.groups[0].results.map((r) => { try { return new URL(r.url).hostname; } catch { return '?'; } });
  console.log('  hosts:', hosts.join(', ') || '(none)');
  const allGh = hosts.every((h) => h.endsWith('github.com'));
  if (hosts.length === 0 || allGh) ok('site filter honoured');
  else bad('site filter leaked: ' + hosts.join(', '));
}

console.log('\n=== 5. empty query list is rejected (with a real key) ===');
const r4 = await tools.keenable_search.execute({ queries: [] });
console.log('  result:', JSON.stringify(r4).slice(0, 120));
if (r4?.error && /at least one/.test(r4.error)) ok('empty list rejected with the right message');
else bad('wrong rejection: ' + JSON.stringify(r4).slice(0, 100));

console.log('\n=== 6. whitespace-only queries are filtered out ===');
const r5 = await tools.keenable_search.execute({ queries: ['   ', ''] });
if (r5?.error && /at least one/.test(r5.error)) ok('blank strings filtered');
else bad('blank strings not filtered: ' + JSON.stringify(r5).slice(0, 100));

console.log('\n=== 7. keenable_fetch on a real URL ===');
const f1 = await tools.keenable_fetch.execute({ url: 'https://deepseek.com', maxChars: 500 });
if (f1?.error) bad('fetch error: ' + f1.error);
else {
  console.log('  content length:', f1.content?.length ?? 0);
  console.log('  first 150:', String(f1.content ?? '').slice(0, 150).replace(/\n/g, ' '));
  if (f1.content && f1.content.length > 0) ok('fetched page content');
  else bad('empty content');
}

console.log('\n=== 8. keenable_fetch rejects a bad URL ===');
const f2 = await tools.keenable_fetch.execute({ url: '' });
if (f2?.error) ok('empty url rejected: ' + f2.error);
else bad('empty url accepted');

console.log('\n' + (fails === 0 ? 'RESULT: END-TO-END OK' : `RESULT: ${fails} failure(s)`));
process.exit(fails ? 1 : 0);
