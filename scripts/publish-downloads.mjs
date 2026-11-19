// Publishes a release's files to downloads.thoughtsonthingsllc.com.
//
// The release jobs attach every artifact to the GitHub release. This script
// runs once they are all done: it downloads those assets, uploads them to the
// `downloads` R2 bucket under vantage/, and writes the desktop updater feed.
//
//   vantage/<versioned file>      every file, kept forever, cached immutably
//   vantage/<versioned file>.sha256
//   vantage/latest/<stable name>  copies of the newest release, version-free
//                                 names for links that should never change
//   vantage/latest.json           the tauri updater feed, uploaded last
//
// It is also the single authoritative writer of latest.json: the desktop
// matrix finishes in parallel, so the feed is rebuilt here from the assets
// that actually made it onto the release.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUCKET = 'downloads';
export const PREFIX = 'vantage';
export const BASE_URL = `https://downloads.thoughtsonthingsllc.com/${PREFIX}`;
const WRANGLER = 'wrangler@4.165.0';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT_LIVED = 'public, max-age=300';

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

/** Release assets that are rebuilt here rather than copied. */
const REGENERATED = new Set(['latest.json', 'SHA256SUMS']);
const CLI_ARCHIVE = /^vantage-([a-z0-9_]+-[a-z0-9_]+)\.(tar\.gz|zip)$/;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Maps release asset names to bucket file names. `name` is the versioned name
 * every release keeps; `latest` is the version-free alias, or null for files
 * that only make sense next to their versioned parent (updater signatures).
 * The CLI archives are the one family released without a version in the name,
 * so they gain one here and keep their current name as the alias.
 */
export function planFiles(assetNames, version) {
  const embedded = new RegExp(`[-_]${escapeRegExp(version)}(?:-1)?(?=[._-])`);
  const files = [];
  for (const source of assetNames) {
    if (REGENERATED.has(source)) continue;
    const cli = CLI_ARCHIVE.exec(source);
    if (cli) {
      files.push({ source, name: `vantage-${version}-${cli[1]}.${cli[2]}`, latest: source });
      continue;
    }
    if (!embedded.test(source)) {
      throw new Error(`${source} has no ${version} in its name, so it would overwrite other releases`);
    }
    files.push({ source, name: source, latest: source.endsWith('.sig') ? null : source.replace(embedded, '') });
  }
  return files;
}

/**
 * Builds the tauri updater feed. A platform is included only when both its
 * artifact and the artifact's `.sig` are present; everything else lands in
 * `missing` so the caller can decide how loud to be.
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
        entry = { signature: readSignature(signature.name), url: artifact.url };
        break;
      }
    }
    if (entry) platforms[key] = entry;
    else missing.push(key);
  }
  return { feed: { version, pub_date: pubDate, platforms }, missing };
}

export function contentType(name) {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.sha256') || name.endsWith('.sig')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = result.stderr || result.stdout || `exit code ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed:\n${output}`);
  }
  return result.stdout;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function main() {
  const tag = process.env.TAG_NAME;
  const repository = process.env.GITHUB_REPOSITORY;
  const version = process.env.VERSION || tag?.replace(/^v/, '');
  const dryRun = process.env.DRY_RUN === '1';
  if (!tag || !version || !repository) {
    throw new Error('TAG_NAME and GITHUB_REPOSITORY are required');
  }

  const workdir = mkdtempSync(join(tmpdir(), 'vantage-downloads-'));
  try {
    const assetsDir = join(workdir, 'assets');
    run('gh', ['release', 'download', tag, '--repo', repository, '--dir', assetsDir]);
    const files = planFiles(readdirSync(assetsDir).sort(), version);
    if (files.length === 0) throw new Error(`Release ${tag} has no assets to publish`);

    const uploads = [];
    const put = (file, key, cacheControl) => uploads.push({ file, key: `${PREFIX}/${key}`, cacheControl });
    const aliases = [];
    const outDir = join(workdir, 'out');
    mkdirSync(outDir);

    for (const { source, name, latest } of files) {
      const path = join(assetsDir, source);
      put(path, name, IMMUTABLE);
      if (name.endsWith('.sig')) continue;
      const digest = sha256(path);
      const checksum = join(outDir, `${name}.sha256`);
      writeFileSync(checksum, `${digest}  ${name}\n`);
      put(checksum, `${name}.sha256`, IMMUTABLE);
      if (latest) {
        const aliasChecksum = join(outDir, `latest-${latest}.sha256`);
        writeFileSync(aliasChecksum, `${digest}  ${latest}\n`);
        aliases.push([path, `latest/${latest}`], [aliasChecksum, `latest/${latest}.sha256`]);
      }
    }
    // Aliases only move once every versioned file they point at is in place.
    for (const [file, key] of aliases) put(file, key, SHORT_LIVED);

    let feedPath = null;
    if (files.some((file) => file.name.endsWith('.sig'))) {
      const { feed, missing } = buildFeed(
        files.map(({ name }) => ({ name, url: `${BASE_URL}/${encodeURIComponent(name)}` })),
        {
          version,
          pubDate: new Date().toISOString(),
          readSignature: (name) => {
            const source = files.find((file) => file.name === name).source;
            return readFileSync(join(assetsDir, source), 'utf8').trim();
          },
        },
      );
      // Updater artifacts exist, so every platform must have made it: a feed
      // that silently omits one would strand that platform's installs.
      if (missing.length > 0) {
        throw new Error(`Release ${tag} is missing updater artifacts for: ${missing.join(', ')}`);
      }
      feedPath = join(outDir, 'latest.json');
      writeFileSync(feedPath, `${JSON.stringify(feed, null, 2)}\n`);
      if (dryRun) console.log(readFileSync(feedPath, 'utf8'));
      // Last, so the feed never names a file that is not downloadable yet.
      put(feedPath, 'latest.json', SHORT_LIVED);
    } else {
      console.log('No updater signatures on this release (signing key not configured); leaving the feed alone.');
    }

    for (const { file, key, cacheControl } of uploads) {
      const args = ['--yes', WRANGLER, 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--remote',
        '--content-type', contentType(key), '--cache-control', cacheControl];
      if (dryRun) {
        console.log(`would upload ${key} (${cacheControl})`);
        continue;
      }
      for (let attempt = 1; ; attempt += 1) {
        try {
          run('npx', args);
          console.log(`uploaded ${key}`);
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          console.log(`retrying ${key}: ${error.message.split('\n')[0]}`);
          await new Promise((done) => setTimeout(done, attempt * 5000));
        }
      }
    }

    // Desktop installs from before the move poll the GitHub release's
    // latest.json. Keep publishing it there (pointing at the downloads site) so
    // they update onto a build that polls the new feed.
    if (feedPath && !dryRun) {
      run('gh', ['release', 'upload', tag, '--repo', repository, feedPath, '--clobber']);
    }
    console.log(`${dryRun ? 'Planned' : 'Published'} ${uploads.length} objects for ${tag} to ${BASE_URL}/`);
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
