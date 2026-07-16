import { execFileSync } from 'node:child_process';

const ports = [...new Set(process.argv.slice(2).map((value) => Number(value)))];
if (!ports.length || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
  console.error('usage: node scripts/free-port.mjs <port> [port ...]');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function command(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', windowsHide: true }).trim();
  } catch (error) {
    // Listener discovery commands use a non-zero exit when nothing matched.
    if (error?.code === 'ENOENT') return null;
    return String(error?.stdout ?? '').trim();
  }
}

function windowsListeners(wanted) {
  const output = command('netstat', ['-ano', '-p', 'tcp']) ?? '';
  const listeners = new Map();
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0]?.toUpperCase() !== 'TCP' || columns[3]?.toUpperCase() !== 'LISTENING') continue;
    const port = Number(/:(\d+)$/.exec(columns[1] ?? '')?.[1]);
    const pid = Number(columns[4]);
    if (wanted.has(port) && Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      if (!listeners.has(port)) listeners.set(port, new Set());
      listeners.get(port).add(pid);
    }
  }
  return listeners;
}

function unixListeners(wanted) {
  const listeners = new Map();
  for (const port of wanted) {
    let output = command('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    if (output === null) output = command('fuser', ['-n', 'tcp', String(port)]);
    const pids = (output ?? '').match(/\d+/g)?.map(Number).filter((pid) => pid > 0 && pid !== process.pid) ?? [];
    if (pids.length) listeners.set(port, new Set(pids));
  }
  return listeners;
}

const wanted = new Set(ports);
const listeners = process.platform === 'win32' ? windowsListeners(wanted) : unixListeners(wanted);

for (const port of ports) {
  const pids = listeners.get(port);
  if (!pids?.size) continue;
  for (const pid of pids) {
    console.log(`→ freeing port ${port} (PID ${pid})`);
    if (process.platform === 'win32') {
      command('taskkill', ['/PID', String(pid), '/T', '/F']);
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }
}

if (process.platform !== 'win32' && listeners.size) {
  await sleep(250);
  for (const pids of listeners.values()) {
    for (const pid of pids) {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
}
