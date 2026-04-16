const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SHARED_DIR = path.join(ROOT, 'shared');
const OUTPUT_DIR = path.join(ROOT, 'output');
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
  const configured =
    tracking && typeof tracking.trackedPath === 'string'
      ? path.resolve(String(tracking.trackedPath))
      : OUTPUT_DIR;
  return configured;
}

function runGenerator() {
  ensureDir(SHARED_DIR);

  if (!fs.existsSync(TRACKING_PATH)) {
    atomicWriteJson(TRACKING_PATH, {
      trackedPath: OUTPUT_DIR,
      updatedAt: new Date().toISOString(),
    });
  }

  const trackedDir = getTrackedDir();
  ensureDir(trackedDir);

  if (!fs.existsSync(PROMPT_PATH)) {
    fs.writeFileSync(PROMPT_PATH, '');
  }

  const prompt = fs.readFileSync(PROMPT_PATH, 'utf8').trim();
  if (!prompt) {
    console.log('[generator] prompt.txt is empty; skipping generation');
    atomicWriteJson(GENERATION_STATUS_PATH, { done: true, finishedAt: new Date().toISOString() });
    return;
  }

  atomicWriteJson(GENERATION_STATUS_PATH, { done: false, finishedAt: null });

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
    atomicWriteJson(GENERATION_STATUS_PATH, { done: true, finishedAt: new Date().toISOString() });
  });

  child.on('error', (error) => {
    console.error('[generator] failed to launch codex:', error.message);
    atomicWriteJson(GENERATION_STATUS_PATH, { done: true, finishedAt: new Date().toISOString() });
  });
}

runGenerator();
