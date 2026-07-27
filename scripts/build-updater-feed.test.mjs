import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFeed } from './build-updater-feed.mjs';

const DOWNLOAD = 'https://github.com/thoughts-on-things/vantage-mc/releases/download/v0.12.0';
const asset = (name) => ({ name, browser_download_url: `${DOWNLOAD}/${name}` });
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
