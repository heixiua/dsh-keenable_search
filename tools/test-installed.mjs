// Verify DSH can actually load the installed package from the profile.
// This resolves by PACKAGE NAME from the profile directory, which is how the
// Host loads it — not by absolute path.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const PROFILE = 'D:\\AI agent cache\\dsh\\profiles\\desktop';
const req = createRequire(PROFILE + '\\');

let fails = 0;
const ok = (m) => console.log('  OK   ' + m);
const bad = (m) => { fails++; console.log('  FAIL ' + m); };

console.log('=== 1. resolve by package name from the profile ===');
let resolved;
try {
  resolved = req.resolve('dsh-keenable-search');
  ok('resolved: ' + resolved.replace(PROFILE, '<profile>'));
} catch (e) {
  bad('cannot resolve by name: ' + e.message.split('\n')[0]);
  process.exit(1);
}

console.log('\n=== 2. the resolved file is our source, not a stale copy ===');
const fs = await import('node:fs');
const src = fs.readFileSync(resolved, 'utf8');
console.log('  bytes:', Buffer.byteLength(src, 'utf8'));
for (const marker of ['keenable_search', 'keenable_fetch', 'KEENABLE_API_KEY', 'keenable-search']) {
  if (src.includes(marker)) ok(`contains ${marker}`);
  else bad(`missing ${marker}`);
}

console.log('\n=== 3. import it the way the Host does ===');
const mod = await import(pathToFileURL(resolved).href);
console.log('  exports:', Object.keys(mod).join(', '));
if (typeof mod.apply === 'function' && Array.isArray(mod.inject)) ok('apply + inject present');
else bad('exports malformed');

console.log('\n=== 4. the patch DSH will read ===');
const patchPath = resolved.replace(/index\.js$/, 'cordis.patch.yml');
const patch = fs.readFileSync(patchPath, 'utf8');
const rowId = /^ {4}- id:\s*(\S+)/m.exec(patch)?.[1];
const rowName = /^ {6}name:\s*(\S+)/m.exec(patch)?.[1];
console.log('  row id:', rowId, ' name:', rowName);
if (rowName === 'dsh-keenable-search') ok('patch name matches the installed package name');
else bad(`patch name ${rowName} != dsh-keenable-search`);

console.log('\n=== 5. profile declares it ===');
const pkgJson = JSON.parse(fs.readFileSync(PROFILE + '\\package.json', 'utf8'));
const inBundles = pkgJson.dsh.profile.bundles.includes('dsh-keenable-search');
const inDeps = Boolean(pkgJson.dependencies['dsh-keenable-search']);
console.log('  in bundles:', inBundles, ' in dependencies:', inDeps);
if (inBundles && inDeps) ok('profile declares both');
else bad('profile declaration incomplete');

console.log('\n=== 6. registration against a fake ctx (with a key present) ===');
const tools = {};
mod.apply({
  logger: { info: (m) => console.log('  [log] ' + m), warn: (m) => console.log('  [warn] ' + m) },
  get: (k) => (k === 'tools' ? { register: (d) => { tools[d.name] = d; return () => {}; } } : undefined),
  effect: (fn) => fn(),
}, {});
console.log('  registered:', Object.keys(tools).join(', '));
if (tools.keenable_search && tools.keenable_fetch) ok('both tools registered from the installed copy');
else bad('registration failed');

console.log('\n=== 7. tool schemas are what the model will see ===');
for (const [name, def] of Object.entries(tools)) {
  const props = Object.keys(def.parameters?.properties ?? {});
  const required = def.parameters?.required ?? [];
  console.log(`  ${name}: params=[${props.join(', ')}] required=[${required.join(', ')}]`);
  if (required.length > 0) ok(`${name} declares required params`);
  else bad(`${name} has no required params`);
}

console.log('\n' + (fails === 0 ? 'RESULT: INSTALLED PACKAGE LOADS CORRECTLY' : `RESULT: ${fails} failure(s)`));
process.exit(fails ? 1 : 0);
