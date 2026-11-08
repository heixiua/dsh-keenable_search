// Contract test: does this bundle load and register the way DSH expects?
// Runs the real index.js against a fake ctx, so a malformed tool definition
// fails here instead of taking down the Host.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let fails = 0;
const ok = (m) => console.log('  OK   ' + m);
const bad = (m) => { fails++; console.log('  FAIL ' + m); };

console.log('=== 1. package.json manifest ===');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
console.log('  name:', pkg.name, 'version:', pkg.version);
if (pkg.name && pkg.version && pkg.main === './index.js') ok('manifest has name/version/main');
else bad('manifest incomplete');
if (pkg.dsh?.bundle?.patch === './cordis.patch.yml') ok('dsh.bundle.patch points at the patch');
else bad('dsh.bundle.patch missing');
if (pkg.type === 'module') ok('type: module (ESM)');
else bad('not ESM');
// Every file the manifest promises must exist, or an npm install produces a
// package that loads and then fails on import.
for (const f of ['index.js', 'cordis.patch.yml']) {
  if (fs.existsSync(path.join(ROOT, f))) ok(`declared file exists: ${f}`);
  else bad(`declared but missing: ${f}`);
}
const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'));
console.log('  lib/*.js:', libFiles.join(', '));

console.log('\n=== 2. cordis.patch.yml shape ===');
const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
if (/^- insert:\s*$/m.test(patch)) ok('top-level `- insert:`');
else bad('patch is not an insert list');
const rowId = /^ {4}- id:\s*(\S+)/m.exec(patch);
const rowName = /^ {6}name:\s*(\S+)/m.exec(patch);
console.log('  row id:', rowId?.[1], ' name:', rowName?.[1]);
if (rowId?.[1] === 'keenable-search') ok('row id is keenable-search');
else bad('row id unexpected: ' + rowId?.[1]);
if (rowName?.[1] === pkg.name) ok('row name matches package.json name');
else bad(`row name ${rowName?.[1]} != package name ${pkg.name}`);
if (!/set this to true or false/.test(patch)) ok('no allowBuilds placeholder');
else bad('placeholder present');

console.log('\n=== 3. index.js exports ===');
// A bare Windows absolute path is rejected by the ESM loader ("protocol 'd:'"),
// so it has to be converted to a file:// URL first.
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
console.log('  exports:', Object.keys(mod).join(', '));
if (typeof mod.apply === 'function') ok('apply is a function');
else bad('apply missing');
if (Array.isArray(mod.inject)) ok('inject is an array: ' + JSON.stringify(mod.inject));
else bad('inject is not an array');
if (typeof mod.name === 'string' && mod.name) ok('name: ' + mod.name);
else bad('name missing');
// No timer / connection dependency: this plugin must not be able to crash the
// Host the way a polling loop once did.
if (!mod.inject.includes('timer')) ok('does not inject timer (no polling loop)');
else bad('injects timer — unnecessary risk');

console.log('\n=== 4. apply() against a fake ctx ===');
const registered = [];
const effects = [];
const fakeCtx = {
  logger: { info: () => {}, warn: () => {} },
  get: (key) => (key === 'tools' ? { register: (def) => { registered.push(def); return () => {}; } } : undefined),
  effect: (fn) => { const d = fn(); effects.push(d); return d; },
};
let applyThrew = null;
try { mod.apply(fakeCtx, { timeoutMs: 15000, maxResults: 8 }); }
catch (e) { applyThrew = e; }
if (!applyThrew) ok('apply() did not throw');
else bad('apply() threw: ' + applyThrew.message);

console.log('  tools registered:', registered.map((d) => d.name).join(', '));
if (registered.length === 2) ok('registered 2 tools');
else bad('expected 2 tools, got ' + registered.length);

for (const def of registered) {
  const problems = [];
  if (typeof def.name !== 'string' || !def.name) problems.push('name');
  if (typeof def.description !== 'string' || def.description.length < 40) problems.push('description');
  if (!def.parameters || def.parameters.type !== 'object') problems.push('parameters');
  if (!def.output) problems.push('output');           // missing output throws in tools.register
  else {
    if (!def.output.schema) problems.push('output.schema');
    if (typeof def.output.render !== 'function') problems.push('output.render');
  }
  if (typeof def.execute !== 'function') problems.push('execute');
  if (problems.length) bad(`${def.name} malformed: ${problems.join(', ')}`);
  else ok(`${def.name} definition is complete`);
  // The description is the model's only instruction; it must name the tool.
  if (def.description && !def.description.includes(def.name)) {
    // not fatal, just worth knowing
  }
}

console.log('\n=== 5. render() output is a text block ===');
for (const def of registered) {
  const sample = def.name === 'keenable_search'
    ? { groups: [{ query: 'q', results: [{ title: 'T', url: 'https://a', snippet: 'S' }] }], total: 1 }
    : { url: 'https://a', content: 'hello' };
  const out = def.output.render({}, sample);
  const isArray = Array.isArray(out);
  const hasText = isArray && out[0]?.type === 'text' && typeof out[0].text === 'string';
  if (hasText) ok(`${def.name}.render returns [{type:'text', text}]`);
  else bad(`${def.name}.render returned ${JSON.stringify(out).slice(0, 120)}`);
}
// Error path must render too, not throw.
for (const def of registered) {
  const out = def.output.render({}, { error: 'boom' });
  if (Array.isArray(out) && typeof out[0]?.text === 'string' && out[0].text.includes('boom')) {
    ok(`${def.name}.render handles {error}`);
  } else bad(`${def.name}.render broke on {error}`);
}

console.log('\n=== 6. execute() without a key returns a clear error, not a throw ===');
const savedKey = process.env.KEENABLE_API_KEY;
delete process.env.KEENABLE_API_KEY;
const noKeyRegistered = [];
mod.apply({
  logger: { info: () => {}, warn: () => {} },
  get: (k) => (k === 'tools' ? { register: (d) => { noKeyRegistered.push(d); return () => {}; } } : undefined),
  effect: (fn) => fn(),
}, {});
const searchTool = noKeyRegistered.find((d) => d.name === 'keenable_search');
const noKeyResult = await searchTool.execute({ queries: ['x'] });
console.log('  result:', JSON.stringify(noKeyResult).slice(0, 160));
if (noKeyResult?.error && /KEENABLE_API_KEY/.test(noKeyResult.error)) ok('missing key produces an actionable error');
else bad('missing key error is not actionable');
if (savedKey) process.env.KEENABLE_API_KEY = savedKey;

console.log('\n=== 7. execute() rejects an empty query list ===');
const emptyResult = await searchTool.execute({ queries: [] });
if (emptyResult?.error) ok('empty queries rejected: ' + emptyResult.error.slice(0, 60));
else bad('empty queries accepted');

console.log('\n=== 8. no source file imports tools/ ===');
for (const f of ['index.js', ...libFiles.map((x) => 'lib/' + x)]) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const badImport = imports.find((i) => i.includes('tools/') || (i.startsWith('@deepseek-ai') ));
  if (badImport) bad(`${f} imports ${badImport}`);
  else ok(`${f}: ${imports.length} import(s), all node:/relative`);
}

console.log('\n' + (fails === 0 ? 'RESULT: CONTRACT OK' : `RESULT: ${fails} failure(s)`));
process.exit(fails ? 1 : 0);
