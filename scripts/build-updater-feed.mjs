// Rebuilds a release's latest.json update feed from its uploaded assets.
//
// The desktop release matrix runs in parallel and every job merges its own
// platform into latest.json with a read-modify-write, so two jobs finishing
// close together can drop each other's entry. This script is the single
// authoritative writer: it runs after every desktop build has uploaded its
// bundles, reads the assets that actually exist on the release, and replaces
// the feed wholesale.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The platforms a signed desktop release must serve, each with the asset
 *  name patterns that carry its update payload, in preference order (the
 *  NSIS installer outranks the MSI on Windows: it supports the passive
 *  install mode the updater configures). */
export const PLATFORMS = [
  { key: 'windows-x86_64', patterns: [/x64[-_]setup\.exe$/i, /x64[^/]*\.msi$/i] },
  { key: 'darwin-aarch64', patterns: [/aarch64\.app\.tar\.gz$/i] },
  { key: 'darwin-x86_64', patterns: [/(x64|x86_64)\.app\.tar\.gz$/i] },
  { key: 'linux-x86_64', patterns: [/(amd64|x86_64|x64)[^/]*\.AppImage$/i] },
];

/**
 * Builds the tauri updater feed from a release's asset list. A platform is
 * included only when both its artifact and the artifact's `.sig` are present;
 * everything else lands in `missing` so the caller can decide how loud to be.
 */
export function buildFeed(assets, { version, pubDate, readSignature }) {
  const platforms = {};
  const missing = [];
  for (const { key, patterns } of PLATFORMS) {
    let entry = null;
    for (const pattern of patterns) {
      const artifact = assets.find((asset) => pattern.test(asset.name));
      const signature = artifact && assets.find((asset) => asset.name === `${artifact.name}.sig`);
      if (artifact && signature) {
        entry = { signature: readSignature(signature.name), url: artifact.browser_download_url };
        break;
      }
    }
    if (entry) platforms[key] = entry;
    else missing.push(key);
  }
  return { feed: { version, pub_date: pubDate, platforms }, missing };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function main() {
  const tag = process.env.TAG_NAME;
  const version = process.env.VERSION;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!tag || !version || !repository) {
    throw new Error('TAG_NAME, VERSION, and GITHUB_REPOSITORY are required');
  }

  const release = JSON.parse(run('gh', ['api', `repos/${repository}/releases/tags/${tag}`]));
  const assets = release.assets.map(({ name, browser_download_url }) => ({ name, browser_download_url }));
  if (!assets.some((asset) => asset.name.endsWith('.sig'))) {
    console.log('No updater signatures on this release (signing key not configured); leaving the feed alone.');
    return;
  }

  const workdir = mkdtempSync(join(tmpdir(), 'vantage-updater-'));
  try {
    run('gh', ['release', 'download', tag, '--repo', repository, '--pattern', '*.sig', '--dir', workdir]);
    const { feed, missing } = buildFeed(assets, {
      version,
      pubDate: new Date().toISOString(),
      readSignature: (name) => readFileSync(join(workdir, name), 'utf8').trim(),
    });
    // Updater artifacts exist, so every platform must have made it: a feed
    // that silently omits one would strand that platform's installs.
    if (missing.length > 0) {
      throw new Error(`Release ${tag} is missing updater artifacts for: ${missing.join(', ')}`);
    }
    const path = join(workdir, 'latest.json');
    writeFileSync(path, `${JSON.stringify(feed, null, 2)}\n`);
    run('gh', ['release', 'upload', tag, '--repo', repository, path, '--clobber']);
    console.log(`latest.json rebuilt with ${Object.keys(feed.platforms).length} platforms.`);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
