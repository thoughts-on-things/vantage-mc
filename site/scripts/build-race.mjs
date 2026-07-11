// Bake the "render race" replay data (src/assets/race.json) from two capture
// files produced by running each tool under a line-timestamping wrapper:
//
//   node capture.mjs out.json <cmd> [args…]   (see the PR that added this)
//
// Usage: node scripts/build-race.mjs <race-vantage.json> <race-bluemap.json>
//
// Line timestamps and progress percentages are kept verbatim from the real
// runs; the only editing is cosmetic (machine-local paths shortened for
// display, wrapper sentinels dropped).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [vantagePath, bluemapPath] = process.argv.slice(2);
if (!vantagePath || !bluemapPath) {
  console.error('usage: node scripts/build-race.mjs <race-vantage.json> <race-bluemap.json>');
  process.exit(1);
}

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

function cleanLine(line) {
  return line
    .replace(/[A-Z]:\\[^\s·]*scratchpad[\\/][^\s·]*/g, 'map/') // temp out dirs
    .replace(/[A-Z]:[\\/]Users[\\/][^\s·]*?\.minecraft/g, '~/.minecraft')
    .replace(/[A-Z]:[\\/]Users[\\/][^\s·\\/]+/g, '~')
    .replace(/\s+$/g, '');
}

function lane(capture, { name, cmd, dropPatterns = [] }) {
  const lines = [];
  const progress = [];
  for (const { t, line } of capture.events) {
    if (line.startsWith('__EXIT__')) continue;
    if (dropPatterns.some((re) => re.test(line))) continue;
    const pct = /(\d+(?:\.\d+)?)%/.exec(line);
    if (pct) progress.push({ t, p: Number(pct[1]) / 100 });
    lines.push({ t, text: cleanLine(line) });
  }
  return { name, cmd, total: capture.total, lines, progress };
}

const vantage = lane(read(vantagePath), {
  name: 'vantage',
  cmd: 'vantage render "New World" --out map/',
  dropPatterns: [/just serve/],
});
const bluemap = lane(read(bluemapPath), {
  name: 'BlueMap CLI',
  cmd: 'java -Xmx4g -jar bluemap-5.22-cli.jar -r',
});

const out = {
  world: 'New World — 7,225 chunks',
  threads: 16,
  vantage,
  bluemap,
};

const dest = join(dirname(fileURLToPath(import.meta.url)), '../src/assets/race.json');
writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(`${dest}: vantage ${vantage.total}ms (${vantage.lines.length} lines), bluemap ${bluemap.total}ms (${bluemap.lines.length} lines)`);
