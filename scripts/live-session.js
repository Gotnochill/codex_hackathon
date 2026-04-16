const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHARED_DIR = path.join(ROOT, 'shared');
const TRACKING_PATH = path.join(SHARED_DIR, 'tracking.json');
const PROMPT_PATH = path.join(SHARED_DIR, 'prompt.txt');

function atomicWriteJson(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function printUsageAndExit() {
  console.error('Usage: npm run live:start -- [--track <folder>] [--prompt "<prompt>"] [--model <model>] [--port 10000] [--no-open] [--no-restart]');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printUsageAndExit();
}
let trackedPath = '';
let prompt = '';
let model = '';
let port = process.env.PORT || '10000';
let noOpen = false;
let noRestart = false;

for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === '--track') {
    trackedPath = args[i + 1] || '';
    i += 1;
    continue;
  }
  if (token === '--prompt') {
    prompt = args[i + 1] || '';
    i += 1;
    continue;
  }
  if (token === '--model') {
    model = args[i + 1] || '';
    i += 1;
    continue;
  }
  if (token === '--port') {
    port = args[i + 1] || port;
    i += 1;
    continue;
  }
  if (token === '--no-open') {
    noOpen = true;
    continue;
  }
  if (token === '--no-restart') {
    noRestart = true;
    continue;
  }
}

fs.mkdirSync(SHARED_DIR, { recursive: true });

let trackedAbs = null;
if (trackedPath) {
  trackedAbs = path.resolve(process.cwd(), trackedPath);
  fs.mkdirSync(trackedAbs, { recursive: true });
  atomicWriteJson(TRACKING_PATH, {
    trackedPath: trackedAbs,
    updatedAt: new Date().toISOString(),
  });
} else if (!fs.existsSync(TRACKING_PATH)) {
  atomicWriteJson(TRACKING_PATH, {
    trackedPath: null,
    updatedAt: null,
  });
}

if (prompt) {
  fs.writeFileSync(PROMPT_PATH, `${prompt.trim()}\n`);
} else {
  // Tracker-only mode: avoid stale prompt from previous runs auto-triggering generator.
  fs.writeFileSync(PROMPT_PATH, '');
}

const env = { ...process.env };
if (!env.OPENAI_API_KEY && env.CODEX_API_KEY) {
  env.OPENAI_API_KEY = env.CODEX_API_KEY;
}
if (model) {
  env.CODEXMAP_CODEX_MODEL = model;
}
env.PORT = String(port);
env.WS_PORT = String(port);
env.HOST = env.HOST || '0.0.0.0';

if (!noRestart) {
  // Best-effort cleanup so we run one clean live instance.
  try {
    spawnSync('fuser', ['-k', `${port}/tcp`], { stdio: 'ignore' });
  } catch (_) {
    // no-op if fuser unavailable
  }
}

console.log(`[live:start] tracking: ${trackedAbs || '(unset, set from web UI)'}`);
console.log(`[live:start] prompt: ${prompt ? 'set' : 'not set (tracker-only mode)'}`);
console.log(`[live:start] url: http://localhost:${port}`);

const child = spawn('node', ['orchestrator.js'], {
  cwd: ROOT,
  stdio: 'inherit',
  env,
});

if (!noOpen) {
  setTimeout(() => {
    const opener = spawn('xdg-open', [`http://localhost:${port}`], {
      cwd: ROOT,
      stdio: 'ignore',
      detached: true,
      env,
    });
    opener.unref();
  }, 1200);
}

function shutdown(signal) {
  if (!child.killed) {
    child.kill(signal);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

child.on('exit', (code) => {
  process.exit(code || 0);
});
