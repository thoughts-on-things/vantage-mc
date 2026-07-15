import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = (path) => JSON.parse(read(path));
const capture = (path, pattern, label = path) => {
  const match = read(path).match(pattern);
  if (!match) throw new Error(`Could not read ${label}`);
  return match[1];
};

const root = json('package.json').version;
const desktopLock = json('desktop/package-lock.json');
const versions = new Map([
  ['package.json', root],
  ['web/package.json', json('web/package.json').version],
  ['web/package-lock.json', json('web/package-lock.json').version],
  ['web package-lock root', json('web/package-lock.json').packages[''].version],
  ['build.zig.zon', capture('build.zig.zon', /\.version\s*=\s*"([^"]+)"/)],
  ['desktop/package.json', json('desktop/package.json').version],
  ['desktop/package-lock.json', desktopLock.version],
  ['desktop package-lock root', desktopLock.packages[''].version],
  ['desktop tauri.conf.json', json('desktop/src-tauri/tauri.conf.json').version],
  ['desktop Cargo.toml', capture('desktop/src-tauri/Cargo.toml', /^version\s*=\s*"([^"]+)"/m)],
  [
    'desktop Cargo.lock',
    capture(
      'desktop/src-tauri/Cargo.lock',
      /\[\[package\]\]\s*\r?\nname = "vantage-desktop"\s*\r?\nversion = "([^"]+)"/,
      'vantage-desktop version in Cargo.lock',
    ),
  ],
]);

let healthy = true;
for (const [file, version] of versions) {
  const matches = version === root;
  console.log(`${matches ? '✓' : '✗'} ${file}: ${version}`);
  healthy &&= matches;
}

if (!healthy) {
  console.error(`\nAll release-bearing files must match package.json (${root}).`);
  process.exit(1);
}
