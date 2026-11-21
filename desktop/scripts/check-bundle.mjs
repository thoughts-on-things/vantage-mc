// Fails the build when the bundle carries more than one copy of a package that
// must be a singleton. The viewer sources are aliased from ../web, so a missing
// `resolve.dedupe` silently pulls react/three from ../web/node_modules too; two
// Reacts crash every hook in the viewer and the window goes blank (0.15.2).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SINGLETONS = ['react', 'react-dom', 'three'];
const assets = fileURLToPath(new URL('../dist/assets/', import.meta.url));
const copies = new Map(SINGLETONS.map((name) => [name, new Set()]));

for (const file of readdirSync(assets).filter((f) => f.endsWith('.js.map'))) {
  const { sources = [] } = JSON.parse(readFileSync(join(assets, file), 'utf8'));
  for (const source of sources) {
    const match = /^(.*node_modules)\/((?:@[^/]+\/)?[^/]+)\//.exec(source);
    if (match && copies.has(match[2])) copies.get(match[2]).add(match[1]);
  }
}

const duplicated = [...copies].filter(([, roots]) => roots.size > 1);
if (duplicated.length > 0) {
  for (const [name, roots] of duplicated) console.error(`bundle has ${roots.size} copies of ${name}: ${[...roots].join(', ')}`);
  process.exit(1);
}
console.log(`bundle check: one copy each of ${SINGLETONS.join(', ')}`);
