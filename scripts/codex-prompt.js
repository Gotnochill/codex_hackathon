const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TRACKING_PATH = path.join(ROOT, 'shared', 'tracking.json');
const DEFAULT_TRACKED_PATH = path.join(ROOT, 'output');

function printUsageAndExit(exitCode = 1) {
  console.error('Usage: npm run live:prompt -- "<prompt text>" [--model <model>]');
  process.exit(exitCode);
}

function getTrackedDir() {
  try {
    const tracking = JSON.parse(fs.readFileSync(TRACKING_PATH, 'utf8'));
    if (tracking && typeof tracking.trackedPath === 'string') {
      return path.resolve(String(tracking.trackedPath));
    }
  } catch (_) {
    // fall through
  }
  return DEFAULT_TRACKED_PATH;
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
if (!fs.existsSync(trackedDir)) {
  fs.mkdirSync(trackedDir, { recursive: true });
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

console.log(`[live:prompt] tracked folder: ${trackedDir}`);
const child = spawn('codex', codexArgs, {
  cwd: trackedDir,
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
