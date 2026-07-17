import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const color = process.stdout.isTTY;
const ansi = (code, value) => color ? `\u001b[${code}m${value}\u001b[0m` : value;
const ok = (message) => console.log(`${ansi('92', '✓')} ${message}`);
const info = (message) => console.log(`${ansi('90', '→')} ${message}`);
const fail = (message) => console.error(`${ansi('91', '✗')} ${message}`);

export const DEFAULT_SERVER_DEV_OPTIONS = Object.freeze({
  world: 'site/demo-world',
  cache: '.vantage-dev/server-cache',
  viewerPort: 8753,
  serverPort: 8755,
  scanInterval: 1,
  open: true,
  build: true,
  smoke: false,
});

const HELP = `\
Vantage Server development walkthrough

Usage:
  just server-dev [world] [options]
  just server-smoke [world] [options]

Arguments:
  world                   Minecraft Java world directory
                          (default: site/demo-world)

Options:
  --cache <path>          Persistent on-demand tile cache
                          (default: .vantage-dev/server-cache)
  --viewer-port <port>    Viewer port (default: 8753)
  --server-port <port>    Vantage Server port (default: 8755)
  --scan-interval <secs>  Region rescan interval (default: 1)
  --no-open               Do not open the default browser
  --skip-build            Reuse the current zig-out binary
  --smoke                 Verify auth, CORS, manifest, and one lazy tile; then exit
  -h, --help              Show this help

Examples:
  just server-dev
  just server-dev "C:\\minecraft-server\\world"
  just server-dev /srv/minecraft/world --no-open
  just server-smoke
`;

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function integerOption(value, option, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${option} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function parseServerDevArgs(argv) {
  const options = { ...DEFAULT_SERVER_DEV_OPTIONS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--world':
        options.world = optionValue(argv, index, argument);
        index += 1;
        break;
      case '--cache':
        options.cache = optionValue(argv, index, argument);
        index += 1;
        break;
      case '--viewer-port':
        options.viewerPort = integerOption(optionValue(argv, index, argument), argument, 1, 65535);
        index += 1;
        break;
      case '--server-port':
        options.serverPort = integerOption(optionValue(argv, index, argument), argument, 1, 65535);
        index += 1;
        break;
      case '--scan-interval':
        options.scanInterval = integerOption(optionValue(argv, index, argument), argument, 1, 3600);
        index += 1;
        break;
      case '--no-open':
        options.open = false;
        break;
      case '--skip-build':
        options.build = false;
        break;
      case '--smoke':
        options.smoke = true;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }
  if (options.viewerPort === options.serverPort) {
    throw new Error('--viewer-port and --server-port must be different');
  }
  if (options.smoke) options.open = false;
  return options;
}

function checked(command, args, cwd, label) {
  info(label);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    shell: isWindows && command.endsWith('.cmd'),
  });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function ensureViewerDependencies() {
  const vite = join(root, 'web', 'node_modules', 'vite', 'bin', 'vite.js');
  if (existsSync(vite)) return vite;
  const npm = isWindows ? 'npm.cmd' : 'npm';
  checked(npm, ['ci', '--no-audit', '--no-fund'], join(root, 'web'), 'Installing viewer dependencies…');
  if (!existsSync(vite)) throw new Error('Vite is still missing after installing web dependencies');
  return vite;
}

async function assertPortFree(port, label) {
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = createServer();
    socket.unref();
    socket.once('error', (error) => {
      rejectPromise(new Error(`${label} port ${port} is already in use (${error.code ?? error.message})`));
    });
    socket.listen({ host: '127.0.0.1', port }, () => socket.close(resolvePromise));
  });
}

function prefixLines(stream, prefix, code) {
  const reader = createInterface({ input: stream });
  reader.on('line', (line) => console.log(`${ansi(code, prefix)} ${line}`));
  return reader;
}

const serviceErrors = new WeakMap();

function spawnService(command, args, options, label, colorCode) {
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serviceErrors.set(child, null);
  child.once('error', (error) => serviceErrors.set(child, error));
  prefixLines(child.stdout, `[${label}]`, colorCode);
  prefixLines(child.stderr, `[${label}]`, colorCode);
  return child;
}

async function waitForHttp(url, child, validate, label) {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    const serviceError = serviceErrors.get(child);
    if (serviceError) throw new Error(`${label} could not start: ${serviceError.message}`);
    if (child.exitCode !== null) throw new Error(`${label} exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (await validate(response)) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`${label} did not become ready: ${lastError?.message ?? 'timed out'}`);
}

function openBrowser(url) {
  const command = isWindows ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = isWindows ? ['/c', 'start', '', url] : [url];
  const browser = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  browser.on('error', () => info(`Open ${url} in your browser.`));
  browser.unref();
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise();
    };
    child.once('exit', finish);
    child.once('error', finish);
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch { /* process already exited */ }
      }
      finish();
    }, 3_000);
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch { finish(); }
    }
  });
}

function assertResponse(condition, message) {
  if (!condition) throw new Error(`smoke check failed: ${message}`);
}

async function smokeCheck(serverUrl, viewerOrigin, token) {
  const request = (path, init = {}) => fetch(new URL(path, serverUrl), {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  const discoveryResponse = await request('/.well-known/vantage');
  assertResponse(discoveryResponse.ok, `discovery returned HTTP ${discoveryResponse.status}`);
  const discovery = await discoveryResponse.json();
  assertResponse(discovery.protocol === 1 && discovery.auth === 'bearer', 'unexpected discovery contract');

  const unauthorized = await request('/v1/worlds');
  assertResponse(unauthorized.status === 401, `unauthenticated request returned HTTP ${unauthorized.status}`);

  // A browser preflights the conditional poll (If-None-Match is not a CORS
  // safelisted header); node's fetch never preflights, so check explicitly.
  const preflight = await request('/v1/worlds/default/manifest.json', {
    method: 'OPTIONS',
    headers: {
      Origin: viewerOrigin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization, if-none-match',
    },
  });
  assertResponse(preflight.status === 204, `preflight returned HTTP ${preflight.status}`);
  const allowedHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  assertResponse(
    allowedHeaders.includes('authorization') && allowedHeaders.includes('if-none-match'),
    'preflight must allow the authorization and if-none-match request headers',
  );

  const authHeaders = { Authorization: `Bearer ${token}`, Origin: viewerOrigin };
  const manifestUrl = new URL('/v1/worlds/default/manifest.json', serverUrl);
  const manifestResponse = await fetch(manifestUrl, {
    headers: authHeaders,
    signal: AbortSignal.timeout(30_000),
  });
  assertResponse(manifestResponse.ok, `manifest returned HTTP ${manifestResponse.status}`);
  assertResponse(
    manifestResponse.headers.get('access-control-allow-origin') === viewerOrigin,
    'manifest did not return the exact configured CORS origin',
  );
  const manifest = await manifestResponse.json();
  assertResponse(manifest.dynamic === true && manifest.rendering === true, 'manifest is not continuous');
  assertResponse(Array.isArray(manifest.tiles) && manifest.tiles.length > 0, 'manifest contains no tiles');
  assertResponse(
    manifest.tiles.every((tile) => typeof tile.revision === 'string' && tile.revision.length > 0),
    'manifest tile revisions are missing',
  );

  const manifestEtag = manifestResponse.headers.get('etag');
  assertResponse(!!manifestEtag, 'manifest is missing its strong ETag validator');
  assertResponse(
    (manifestResponse.headers.get('access-control-expose-headers') ?? '').toLowerCase().includes('etag'),
    'manifest ETag is not exposed to cross-origin scripts',
  );
  // Nothing baked between these two reads, so the body is byte-identical and
  // the conditional poll must short-circuit to an empty 304.
  const conditionalResponse = await fetch(manifestUrl, {
    headers: { ...authHeaders, 'If-None-Match': manifestEtag },
    signal: AbortSignal.timeout(30_000),
  });
  assertResponse(conditionalResponse.status === 304, `conditional manifest returned HTTP ${conditionalResponse.status}`);
  assertResponse(conditionalResponse.headers.get('etag') === manifestEtag, 'the 304 must re-state the current validator');
  assertResponse((await conditionalResponse.arrayBuffer()).byteLength === 0, 'a 304 must not carry a body');

  const tileUrl = new URL(manifest.tiles[0].path, manifestUrl);
  const tileResponse = await fetch(tileUrl, {
    headers: authHeaders,
    signal: AbortSignal.timeout(30_000),
  });
  assertResponse(tileResponse.ok, `lazy tile returned HTTP ${tileResponse.status}`);
  assertResponse(
    tileResponse.headers.get('access-control-allow-origin') === viewerOrigin,
    'lazy tile did not return the exact configured CORS origin',
  );
  await tileResponse.arrayBuffer();
  return manifest.tiles.length;
}

export async function runServerDev(options) {
  const world = resolve(root, options.world);
  const cache = resolve(root, options.cache);
  const binary = join(root, 'zig-out', 'bin', isWindows ? 'vantage.exe' : 'vantage');
  const viewerUrl = `http://127.0.0.1:${options.viewerPort}/`;
  const serverUrl = `http://127.0.0.1:${options.serverPort}/`;

  if (!existsSync(world)) throw new Error(`world directory does not exist: ${world}`);
  if (!existsSync(join(world, 'level.dat'))) throw new Error(`level.dat was not found in: ${world}`);

  const vite = ensureViewerDependencies();
  await Promise.all([
    assertPortFree(options.viewerPort, 'viewer'),
    assertPortFree(options.serverPort, 'server'),
  ]);

  if (options.build) checked('zig', ['build', '-Doptimize=ReleaseFast'], root, 'Building Vantage…');
  if (!existsSync(binary)) throw new Error(`Vantage binary is missing: ${binary} (remove --skip-build)`);
  mkdirSync(cache, { recursive: true });

  const token = randomBytes(32).toString('base64url');
  const server = spawnService(binary, [
    'server', world,
    '--out', cache,
    '--host', '127.0.0.1',
    '--port', String(options.serverPort),
    '--token-env', 'VANTAGE_SERVER_TOKEN',
    '--allow-origin', viewerUrl.slice(0, -1),
    '--scan-interval', String(options.scanInterval),
  ], {
    cwd: root,
    env: { ...process.env, VANTAGE_SERVER_TOKEN: token },
  }, 'server', '94');

  let viewer = null;
  let stopping = false;
  let shutdownPromise = null;
  let resolveDone;
  const done = new Promise((resolvePromise) => { resolveDone = resolvePromise; });
  let exitCode = 0;

  const shutdown = (code = 0) => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    exitCode = code;
    info('Stopping viewer and Vantage Server…');
    shutdownPromise = Promise.all([stopChild(viewer), stopChild(server)]).then(resolveDone);
    return shutdownPromise;
  };

  const unexpectedExit = (label) => (code, signal) => {
    if (stopping) return;
    fail(`${label} stopped unexpectedly (${signal ?? `exit ${code ?? 1}`}).`);
    void shutdown(code === 0 ? 1 : (code ?? 1));
  };
  server.once('exit', unexpectedExit('Vantage Server'));

  process.once('SIGINT', () => { void shutdown(0); });
  process.once('SIGTERM', () => { void shutdown(0); });

  try {
    await waitForHttp(
      `${serverUrl}v1/health`,
      server,
      async (response) => response.ok && (await response.json()).status === 'ok',
      'Vantage Server',
    );
    ok(`Vantage Server ready — protocol v1, bearer auth`);

    viewer = spawnService(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(options.viewerPort), '--strictPort'], {
      cwd: join(root, 'web'),
      env: {
        ...process.env,
        VITE_VANTAGE_SERVER_ENDPOINT: serverUrl,
        VITE_VANTAGE_SERVER_TOKEN: token,
      },
    }, 'viewer', '96');
    viewer.once('exit', unexpectedExit('Viewer'));

    await waitForHttp(viewerUrl, viewer, async (response) => response.ok, 'Viewer');
    ok(`Authenticated viewer ready — ${viewerUrl}`);
    if (options.smoke) {
      info('Checking discovery, bearer auth, CORS, manifest revisions, and lazy baking…');
      const tileCount = await smokeCheck(serverUrl, viewerUrl.slice(0, -1), token);
      ok(`End-to-end smoke check passed — ${tileCount} advertised tiles`);
      await shutdown(0);
      await done;
      return;
    }
    console.log(`\n${ansi('1;97', 'Vantage Server walkthrough')}`);
    console.log(`  world   ${world}`);
    console.log(`  cache   ${cache}`);
    console.log(`  viewer  ${ansi('4;96', viewerUrl)}`);
    console.log(`\n  First-time tiles bake as you explore. Press ${ansi('1', 'Ctrl+C')} to stop both services.\n`);
    if (options.open) openBrowser(viewerUrl);

    await done;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    await shutdown(1);
    await done;
  }
  process.exitCode = exitCode;
}

async function main() {
  let options;
  try {
    options = parseServerDevArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    console.error(`\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }
  console.log(`\n${ansi('1;97', 'Vantage Server')} ${ansi('90', 'development')}\n`);
  await runServerDev(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
