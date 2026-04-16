const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TRACKING_PATH = path.join(ROOT, 'shared', 'tracking.json');
const GENERATION_STATUS_PATH = path.join(ROOT, 'shared', 'generation-status.json');

function printUsageAndExit(exitCode = 1) {
  console.error('Usage: npm run live:prompt -- "<prompt text>" [--model <model>]');
  process.exit(exitCode);
}

function getTrackedDir() {
  try {
    const tracking = JSON.parse(fs.readFileSync(TRACKING_PATH, 'utf8'));
    if (tracking && typeof tracking.trackedPath === 'string' && tracking.trackedPath.trim()) {
      return path.resolve(String(tracking.trackedPath).trim());
    }
  } catch (_) {
    // fall through
  }
  return null;
}

function writeGenerationStatus({ running, done, startedAt, finishedAt }) {
  const payload = {
    running: Boolean(running),
    done: Boolean(done),
    startedAt: startedAt || null,
    finishedAt: finishedAt || null,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${GENERATION_STATUS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, GENERATION_STATUS_PATH);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printUsageAndExit(0);
}
if (args.length === 0) {
  printUsageAndExit(1);
}

let model = process.env.CODEXMAP_CODEX_MODEL || '';
const promptParts = [];

for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === '--model') {
    model = args[i + 1] || '';
    i += 1;
    continue;
  }
  promptParts.push(token);
}

const prompt = promptParts.join(' ').trim();
if (!prompt) {
  printUsageAndExit();
}

const trackedDir = getTrackedDir();
if (!trackedDir) {
  console.error('[live:prompt] tracking path is not set. Set it from the web UI first.');
  process.exit(1);
}
let trackedDirAvailable = false;
try {
  trackedDirAvailable = fs.existsSync(trackedDir) && fs.statSync(trackedDir).isDirectory();
} catch (_) {
  trackedDirAvailable = false;
}
if (!trackedDirAvailable) {
  console.error(`[live:prompt] tracked folder is unavailable: ${trackedDir}`);
  process.exit(1);
}

const env = { ...process.env };
if (!env.OPENAI_API_KEY && env.CODEX_API_KEY) {
  env.OPENAI_API_KEY = env.CODEX_API_KEY;
}

const codexArgs = [
  'exec',
  '--full-auto',
  '--sandbox',
  'workspace-write',
  '--skip-git-repo-check',
];

if (model) {
  codexArgs.push('--model', model);
}

codexArgs.push(prompt);
const startedAt = new Date().toISOString();
writeGenerationStatus({ running: true, done: false, startedAt, finishedAt: null });

console.log(`[live:prompt] tracked folder: ${trackedDir}`);
const child = spawn('codex', codexArgs, {
  cwd: trackedDir,
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => {
  writeGenerationStatus({
    running: false,
    done: true,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  process.exit(code || 0);
});

child.on('error', () => {
  writeGenerationStatus({
    running: false,
    done: true,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
});
