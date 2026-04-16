const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SHARED_DIR = path.join(ROOT, 'shared');
const PROMPT_PATH = path.join(SHARED_DIR, 'prompt.txt');
const GENERATION_STATUS_PATH = path.join(SHARED_DIR, 'generation-status.json');
const TRACKING_PATH = path.join(SHARED_DIR, 'tracking.json');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function getTrackedDir() {
  const tracking = safeReadJson(TRACKING_PATH, {});
  if (tracking && typeof tracking.trackedPath === 'string' && tracking.trackedPath.trim()) {
    return path.resolve(String(tracking.trackedPath).trim());
  }
  return null;
}

function writeGenerationStatus({ running, done, startedAt, finishedAt }) {
  atomicWriteJson(GENERATION_STATUS_PATH, {
    running: Boolean(running),
    done: Boolean(done),
    startedAt: startedAt || null,
    finishedAt: finishedAt || null,
    updatedAt: new Date().toISOString(),
  });
}

function runGenerator() {
  ensureDir(SHARED_DIR);

  if (!fs.existsSync(TRACKING_PATH)) {
    atomicWriteJson(TRACKING_PATH, {
      trackedPath: null,
      updatedAt: null,
    });
  }

  if (!fs.existsSync(PROMPT_PATH)) {
    fs.writeFileSync(PROMPT_PATH, '');
  }
  if (!fs.existsSync(GENERATION_STATUS_PATH)) {
    writeGenerationStatus({ running: false, done: false, startedAt: null, finishedAt: null });
  }

  const prompt = fs.readFileSync(PROMPT_PATH, 'utf8').trim();
  if (!prompt) {
    console.log('[generator] prompt.txt is empty; skipping generation');
    writeGenerationStatus({ running: false, done: false, startedAt: null, finishedAt: null });
    return;
  }

  const trackedDir = getTrackedDir();
  if (!trackedDir) {
    console.log('[generator] tracking path is not set; skipping generation');
    writeGenerationStatus({ running: false, done: false, startedAt: null, finishedAt: null });
    return;
  }

  let trackedDirAvailable = false;
  try {
    trackedDirAvailable = fs.existsSync(trackedDir) && fs.statSync(trackedDir).isDirectory();
  } catch (_) {
    trackedDirAvailable = false;
  }

  if (!trackedDirAvailable) {
    console.log(`[generator] tracked path is unavailable: ${trackedDir}`);
    writeGenerationStatus({ running: false, done: false, startedAt: null, finishedAt: null });
    return;
  }

  const startedAt = new Date().toISOString();
  writeGenerationStatus({ running: true, done: false, startedAt, finishedAt: null });

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

  if (env.CODEXMAP_CODEX_MODEL) {
    codexArgs.push('--model', env.CODEXMAP_CODEX_MODEL);
  }

  codexArgs.push(prompt);

  const child = spawn('codex', codexArgs, {
    cwd: trackedDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[generator] ${String(chunk)}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[generator] ${String(chunk)}`);
  });

  child.on('close', () => {
    writeGenerationStatus({
      running: false,
      done: true,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  });

  child.on('error', (error) => {
    console.error('[generator] failed to launch codex:', error.message);
    writeGenerationStatus({
      running: false,
      done: true,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  });
}

runGenerator();
