import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'native';
const isWindows = process.platform === 'win32';
const npmShim = isWindows ? 'npm.cmd' : 'npm';
const npmCli = process.env.npm_execpath;
const npm = npmCli ? process.execPath : npmShim;
const npmArgs = (args) => npmCli ? [npmCli, ...args] : args;
const npmNeedsShell = isWindows && !npmCli;
const color = process.stdout.isTTY;
const ansi = (code, value) => color ? `\u001b[${code}m${value}\u001b[0m` : value;
const ok = (message) => console.log(`${ansi('92', '✓')} ${message}`);
const info = (message) => console.log(`${ansi('90', '→')} ${message}`);
const fail = (message, hint) => {
  console.error(`${ansi('91', '✗')} ${message}`);
  if (hint) console.error(`  ${ansi('90', hint)}`);
};

function result(command, args = []) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true });
}

function commandVersion(command, args = ['--version']) {
  const check = result(command, args);
  if (check.status !== 0) return null;
  return (check.stdout || check.stderr).trim().split(/\r?\n/, 1)[0];
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    fail(`Node ${process.versions.node} is too old.`, 'Install Node 18 or newer: https://nodejs.org');
    return false;
  }
  ok(`Node ${process.version}`);
  return true;
}

function checkNativeTools() {
  let healthy = true;
  const zig = commandVersion('zig', ['version']);
  if (!zig) {
    fail('Zig was not found.', 'Install Zig 0.16.0 and make sure `zig` is on PATH: https://ziglang.org/download');
    healthy = false;
  } else if (!zig.startsWith('0.16.')) {
    fail(`Zig ${zig} is installed, but this repository requires 0.16.x.`, 'Use Zig 0.16.0 to avoid pre-1.0 compiler incompatibilities.');
    healthy = false;
  } else {
    ok(`Zig ${zig}`);
  }

  const rust = commandVersion('rustc', ['--version']);
  const cargo = commandVersion('cargo', ['--version']);
  if (!rust || !cargo) {
    fail('The Rust toolchain was not found.', 'Install Rust stable with rustup: https://rustup.rs');
    healthy = false;
  } else {
    ok(rust);
    ok(cargo);
  }

  if (isWindows) {
    const host = result('rustc', ['-vV']).stdout ?? '';
    if (host && !host.includes('pc-windows-msvc')) {
      fail('Rust is not using the Windows MSVC toolchain.', 'Run `rustup default stable-x86_64-pc-windows-msvc` and install Visual Studio C++ Build Tools.');
      healthy = false;
    } else if (host) {
      ok('Windows MSVC target');
    }
    info('WebView2 is supplied by current Windows installations; Tauri will report if it is missing.');
  }
  return healthy;
}

function lockDigest(workspace) {
  return createHash('sha256')
    .update(readFileSync(join(root, workspace, 'package.json')))
    .update(readFileSync(join(root, workspace, 'package-lock.json')))
    .digest('hex');
}

function ensureDependencies(workspace) {
  const directory = join(root, workspace);
  const modules = join(directory, 'node_modules');
  const marker = join(modules, '.vantage-lock');
  const digest = lockDigest(workspace);
  if (existsSync(marker) && readFileSync(marker, 'utf8') === digest) {
    ok(`${workspace} dependencies`);
    return true;
  }

  info(`Installing ${workspace} dependencies (first run or lockfile changed)…`);
  const install = spawnSync(npm, npmArgs(['ci', '--no-audit', '--no-fund']), {
    cwd: directory,
    stdio: 'inherit',
    windowsHide: true,
    shell: npmNeedsShell,
  });
  if (install.status !== 0) {
    fail(`Could not install ${workspace} dependencies.`, install.error?.message);
    return false;
  }
  writeFileSync(marker, digest);
  ok(`${workspace} dependencies installed`);
  return true;
}

function bootstrap() {
  return ensureDependencies('web') && ensureDependencies('desktop');
}

function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: false, shell: npmNeedsShell && command === npm });
  child.on('error', (error) => {
    fail(`Could not start ${command}: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

function runChecked(command, args, cwd, label) {
  info(label);
  const child = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: false,
    shell: npmNeedsShell && command === npm,
  });
  if (child.status !== 0) process.exit(child.status ?? 1);
}

console.log(`\n${ansi('1;97', 'Vantage Desktop')} ${ansi('90', 'development')}\n`);

if (!checkNode()) process.exit(1);

if (mode === 'doctor') {
  const native = checkNativeTools();
  const webReady = existsSync(join(root, 'web', 'node_modules'));
  const desktopReady = existsSync(join(root, 'desktop', 'node_modules'));
  (webReady ? ok : info)(`web dependencies ${webReady ? 'installed' : 'not installed — npm run setup will install them'}`);
  (desktopReady ? ok : info)(`desktop dependencies ${desktopReady ? 'installed' : 'not installed — npm run setup will install them'}`);
  console.log(native ? `\n${ansi('92', 'Ready to build.')}\n` : `\n${ansi('91', 'Fix the items above, then rerun npm run doctor.')}\n`);
  process.exit(native ? 0 : 1);
}

if (mode !== 'ui' && !checkNativeTools()) process.exit(1);
if (!bootstrap()) process.exit(1);

if (mode === 'setup') {
  console.log(`\n${ansi('92', 'Ready.')} Run ${ansi('1', 'npm run dev')} to launch the desktop app.\n`);
} else if (mode === 'ui') {
  info('Starting the fast browser UI loop with mock worlds…');
  run(npm, npmArgs(['run', 'dev', '--', '--open']), join(root, 'desktop'));
} else if (mode === 'native') {
  info('Starting Vite + Tauri + the Zig sidecar…');
  info('The first native compile can take a minute; later launches are incremental.');
  run(npm, npmArgs(['run', 'desktop:dev']), join(root, 'desktop'));
} else if (mode === 'build') {
  info('Building the Windows installer and bundled Zig sidecar…');
  run(npm, npmArgs(['run', 'desktop:build']), join(root, 'desktop'));
} else if (mode === 'check') {
  runChecked('zig', ['build', 'test'], root, 'Running Zig tests…');
  runChecked(npm, npmArgs(['run', 'ci']), join(root, 'web'), 'Checking the renderer package…');
  runChecked(npm, npmArgs(['run', 'build']), join(root, 'desktop'), 'Checking the desktop frontend…');
  runChecked('cargo', ['fmt', '--check'], join(root, 'desktop', 'src-tauri'), 'Checking Rust formatting…');
  runChecked('cargo', ['check'], join(root, 'desktop', 'src-tauri'), 'Checking the native host and Zig sidecar…');
  console.log(`\n${ansi('92', 'All checks passed.')}\n`);
} else {
  fail(`Unknown development mode: ${mode}`);
  process.exit(1);
}
