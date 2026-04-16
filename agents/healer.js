const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = path.join(ROOT, 'shared', 'heal-queue.json');
const PROMPT_PATH = path.join(ROOT, 'shared', 'prompt.txt');
const SETTINGS_PATH = path.join(ROOT, 'shared', 'settings.json');
const STATE_PATH = path.join(ROOT, 'shared', 'map-state.json');
const TRACKING_PATH = path.join(ROOT, 'shared', 'tracking.json');

const MAX_ATTEMPTS = 2;
let healing = false;

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function atomicWriteJson(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function getTrackedDir() {
  const tracking = safeReadJson(TRACKING_PATH, {});
  if (tracking && typeof tracking.trackedPath === 'string' && tracking.trackedPath.trim()) {
    return path.resolve(String(tracking.trackedPath).trim());
  }
  return null;
}

function ensureSharedFiles() {
  if (!fs.existsSync(path.dirname(QUEUE_PATH))) {
    fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  }

  if (!fs.existsSync(QUEUE_PATH)) {
    atomicWriteJson(QUEUE_PATH, { queue: [] });
  }

  if (!fs.existsSync(SETTINGS_PATH)) {
    atomicWriteJson(SETTINGS_PATH, { autoHeal: false });
  }

  if (!fs.existsSync(TRACKING_PATH)) {
    atomicWriteJson(TRACKING_PATH, {
      trackedPath: null,
      updatedAt: null,
    });
  }
}

function buildHealPrompt(nodeId, originalPrompt) {
  return `
The file at ${nodeId} has drifted from the original intent of this project.
Original project prompt: ${originalPrompt}

Rewrite ${nodeId} so that it strictly and completely fulfills the responsibilities
described in the original prompt above. Rules:
- Do not add features, classes, or functions not described in the original prompt.
- Do not change any other files.
- Preserve the programming language and file extension.
- Output only the rewritten file.
`.trim();
}

function findNextPending(queue) {
  return queue.queue.find((entry) => entry.status === 'pending' && entry.attemptCount < MAX_ATTEMPTS);
}

function processQueue() {
  if (healing) return;

  const queue = safeReadJson(QUEUE_PATH, { queue: [] });
  const next = findNextPending(queue);
  if (!next) return;

  healing = true;
  next.status = 'healing';
  next.startedAt = new Date().toISOString();
  next.attemptCount += 1;
  atomicWriteJson(QUEUE_PATH, queue);

  const originalPrompt = fs.existsSync(PROMPT_PATH) ? fs.readFileSync(PROMPT_PATH, 'utf8').trim() : '';
  const healPrompt = buildHealPrompt(next.nodeId, originalPrompt);

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

  codexArgs.push(healPrompt);
  const trackedDir = getTrackedDir();
  let trackedDirAvailable = false;
  try {
    trackedDirAvailable = Boolean(trackedDir) && fs.existsSync(trackedDir) && fs.statSync(trackedDir).isDirectory();
  } catch (_) {
    trackedDirAvailable = false;
  }
  if (!trackedDirAvailable) {
    const queueAfter = safeReadJson(QUEUE_PATH, { queue: [] });
    const entry = queueAfter.queue.find((item) => item.nodeId === next.nodeId && item.status === 'healing');
    if (entry) {
      entry.status = 'failed';
      entry.completedAt = new Date().toISOString();
    }
    atomicWriteJson(QUEUE_PATH, queueAfter);
    healing = false;
    setTimeout(processQueue, 500);
    return;
  }

  const codex = spawn('codex', codexArgs, {
    cwd: trackedDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  codex.on('close', (code) => {
    const queueAfter = safeReadJson(QUEUE_PATH, { queue: [] });
    const entry = queueAfter.queue.find((item) => item.nodeId === next.nodeId && item.status === 'healing');

    if (entry) {
      entry.status = code === 0 ? 'done' : 'failed';
      entry.completedAt = new Date().toISOString();
      // Keep reanchorOutputFlag true until Sentinel re-scores this node.
    }

    atomicWriteJson(QUEUE_PATH, queueAfter);
    healing = false;

    setTimeout(processQueue, 500);
  });

  codex.on('error', () => {
    const queueAfter = safeReadJson(QUEUE_PATH, { queue: [] });
    const entry = queueAfter.queue.find((item) => item.nodeId === next.nodeId && item.status === 'healing');

    if (entry) {
      entry.status = 'failed';
      entry.completedAt = new Date().toISOString();
    }

    atomicWriteJson(QUEUE_PATH, queueAfter);
    healing = false;
    setTimeout(processQueue, 500);
  });
}

function autoEnqueueRedNodes(state) {
  const settings = safeReadJson(SETTINGS_PATH, { autoHeal: false });
  if (!settings.autoHeal) return;

  const queue = safeReadJson(QUEUE_PATH, { queue: [] });
  const now = new Date().toISOString();

  const latestByNode = new Map();
  queue.queue.forEach((entry, index) => {
    latestByNode.set(entry.nodeId, { entry, index });
  });

  let changed = false;

  (state.nodes || [])
    .filter((node) => node.grade === 'red')
    .forEach((node) => {
      const existing = latestByNode.get(node.id);

      if (!existing) {
        queue.queue.push({
          nodeId: node.id,
          status: 'pending',
          triggeredBy: 'auto',
          enqueuedAt: now,
          startedAt: null,
          completedAt: null,
          attemptCount: 0,
          lastScore: typeof node.score === 'number' ? node.score : 0,
          reanchorOutputFlag: true,
        });
        changed = true;
        return;
      }

      const current = existing.entry;
      if (current.status === 'pending' || current.status === 'healing' || current.status === 'done') {
        return;
      }

      // failed status: retry only if still under max attempts.
      if (current.status === 'failed' && current.attemptCount < MAX_ATTEMPTS) {
        current.status = 'pending';
        current.triggeredBy = 'auto';
        current.enqueuedAt = now;
        current.startedAt = null;
        current.completedAt = null;
        current.lastScore = typeof node.score === 'number' ? node.score : current.lastScore;
        current.reanchorOutputFlag = true;
        changed = true;
      }
    });

  if (changed) {
    atomicWriteJson(QUEUE_PATH, queue);
  }
}

ensureSharedFiles();

const queueWatcher = chokidar.watch(QUEUE_PATH, {
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 100,
    pollInterval: 25,
  },
});

queueWatcher.on('change', processQueue);
queueWatcher.on('add', processQueue);

const stateWatcher = chokidar.watch(STATE_PATH, {
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 200,
    pollInterval: 40,
  },
});

stateWatcher.on('change', () => {
  const state = safeReadJson(STATE_PATH, { nodes: [] });
  autoEnqueueRedNodes(state);
  processQueue();
});

stateWatcher.on('add', () => {
  const state = safeReadJson(STATE_PATH, { nodes: [] });
  autoEnqueueRedNodes(state);
  processQueue();
});

processQueue();
