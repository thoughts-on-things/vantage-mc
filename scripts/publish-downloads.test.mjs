import assert from 'node:assert/strict';
import test from 'node:test';

import { BASE_URL, buildFeed, contentType, planFiles } from './publish-downloads.mjs';

const DOWNLOAD = BASE_URL;
const asset = (name) => ({ name, url: `${DOWNLOAD}/${name}` });
const withSig = (name) => [asset(name), asset(`${name}.sig`)];
const readSignature = (name) => `sig:${name}`;

const FULL_RELEASE = [
  ...withSig('Vantage_0.12.0_x64-setup.exe'),
  asset('Vantage_0.12.0_x64_en-US.msi'),
  ...withSig('Vantage_0.12.0_aarch64.app.tar.gz'),
  ...withSig('Vantage_0.12.0_x64.app.tar.gz'),
  ...withSig('Vantage_0.12.0_amd64.AppImage'),
  asset('Vantage_0.12.0_amd64.deb'),
  asset('Vantage_0.12.0_aarch64.dmg'),
  asset('vantage-x86_64-windows.zip'),
];

test('a complete release maps every updater platform to its signed artifact', () => {
  const { feed, missing } = buildFeed(FULL_RELEASE, {
    version: '0.12.0',
    pubDate: '2026-07-27T00:00:00.000Z',
    readSignature,
  });
  assert.deepEqual(missing, []);
  assert.equal(feed.version, '0.12.0');
  assert.equal(feed.pub_date, '2026-07-27T00:00:00.000Z');
  assert.deepEqual(feed.platforms, {
    'windows-x86_64': {
      signature: 'sig:Vantage_0.12.0_x64-setup.exe.sig',
      url: `${DOWNLOAD}/Vantage_0.12.0_x64-setup.exe`,
    },
    'darwin-aarch64': {
      signature: 'sig:Vantage_0.12.0_aarch64.app.tar.gz.sig',
      url: `${DOWNLOAD}/Vantage_0.12.0_aarch64.app.tar.gz`,
    },
    'darwin-x86_64': {
      signature: 'sig:Vantage_0.12.0_x64.app.tar.gz.sig',
      url: `${DOWNLOAD}/Vantage_0.12.0_x64.app.tar.gz`,
    },
    'linux-x86_64': {
      signature: 'sig:Vantage_0.12.0_amd64.AppImage.sig',
      url: `${DOWNLOAD}/Vantage_0.12.0_amd64.AppImage`,
    },
  });
});

test('the darwin arch patterns never cross-match each other', () => {
  // "x64" appears inside neither "aarch64" name, and the x86_64 pattern must
  // not swallow the aarch64 artifact when it happens to sort first.
  const { feed } = buildFeed(
    [...withSig('Vantage_0.12.0_aarch64.app.tar.gz'), ...withSig('Vantage_0.12.0_x64.app.tar.gz')],
    { version: '0.12.0', pubDate: 'now', readSignature },
  );
  assert.match(feed.platforms['darwin-aarch64'].url, /aarch64\.app\.tar\.gz$/);
  assert.match(feed.platforms['darwin-x86_64'].url, /x64\.app\.tar\.gz$/);
});

test('an artifact without its signature is reported missing, not half-included', () => {
  const release = FULL_RELEASE.filter((entry) => entry.name !== 'Vantage_0.12.0_amd64.AppImage.sig');
  const { feed, missing } = buildFeed(release, { version: '0.12.0', pubDate: 'now', readSignature });
  assert.deepEqual(missing, ['linux-x86_64']);
  assert.equal(feed.platforms['linux-x86_64'], undefined);
});

test('windows falls back to the signed MSI when no NSIS bundle exists', () => {
  const { feed, missing } = buildFeed(
    [...withSig('Vantage_0.12.0_x64_en-US.msi')],
    { version: '0.12.0', pubDate: 'now', readSignature },
  );
  assert.equal(missing.includes('windows-x86_64'), false);
  assert.match(feed.platforms['windows-x86_64'].url, /\.msi$/);
});

// The asset list of v0.15.1, the last release published only to GitHub.
const V0151 = [
  'latest.json',
  'SHA256SUMS',
  'thoughts-on-things-vantage-mc-0.15.1.tgz',
  'Vantage-0.15.1-1.x86_64.rpm',
  'Vantage-0.15.1-1.x86_64.rpm.sig',
  'vantage-aarch64-linux.tar.gz',
  'vantage-x86_64-windows.zip',
  'Vantage_0.15.1_aarch64.app.tar.gz',
  'Vantage_0.15.1_aarch64.app.tar.gz.sig',
  'Vantage_0.15.1_aarch64.dmg',
  'Vantage_0.15.1_amd64.AppImage',
  'Vantage_0.15.1_x64-setup.exe',
  'Vantage_0.15.1_x64_en-US.msi',
];

test('every release file gets a versioned name and installers get a stable alias', () => {
  const byName = Object.fromEntries(planFiles(V0151, '0.15.1').map((f) => [f.source, [f.name, f.latest]]));
  assert.deepEqual(byName, {
    'thoughts-on-things-vantage-mc-0.15.1.tgz': ['thoughts-on-things-vantage-mc-0.15.1.tgz', 'thoughts-on-things-vantage-mc.tgz'],
    'Vantage-0.15.1-1.x86_64.rpm': ['Vantage-0.15.1-1.x86_64.rpm', 'Vantage.x86_64.rpm'],
    'Vantage-0.15.1-1.x86_64.rpm.sig': ['Vantage-0.15.1-1.x86_64.rpm.sig', null],
    'vantage-aarch64-linux.tar.gz': ['vantage-0.15.1-aarch64-linux.tar.gz', 'vantage-aarch64-linux.tar.gz'],
    'vantage-x86_64-windows.zip': ['vantage-0.15.1-x86_64-windows.zip', 'vantage-x86_64-windows.zip'],
    'Vantage_0.15.1_aarch64.app.tar.gz': ['Vantage_0.15.1_aarch64.app.tar.gz', 'Vantage_aarch64.app.tar.gz'],
    'Vantage_0.15.1_aarch64.app.tar.gz.sig': ['Vantage_0.15.1_aarch64.app.tar.gz.sig', null],
    'Vantage_0.15.1_aarch64.dmg': ['Vantage_0.15.1_aarch64.dmg', 'Vantage_aarch64.dmg'],
    'Vantage_0.15.1_amd64.AppImage': ['Vantage_0.15.1_amd64.AppImage', 'Vantage_amd64.AppImage'],
    'Vantage_0.15.1_x64-setup.exe': ['Vantage_0.15.1_x64-setup.exe', 'Vantage_x64-setup.exe'],
    'Vantage_0.15.1_x64_en-US.msi': ['Vantage_0.15.1_x64_en-US.msi', 'Vantage_x64_en-US.msi'],
  });
});

test('a version-free asset is refused instead of overwriting other releases', () => {
  assert.throws(() => planFiles(['notes.txt'], '0.15.1'), /no 0\.15\.1 in its name/);
  // A different release's version does not count as "versioned".
  assert.throws(() => planFiles(['Vantage_0.15.10_amd64.deb'], '0.15.1'));
});

test('uploads carry a content type the browser can act on', () => {
  assert.equal(contentType('vantage/latest.json'), 'application/json');
  assert.equal(contentType('vantage/a.exe.sha256'), 'text/plain; charset=utf-8');
  assert.equal(contentType('vantage/a.dmg'), 'application/octet-stream');
});
