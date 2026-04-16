const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');

const ROOT = path.resolve(__dirname, '..');
const HISTORY_PATH = path.join(ROOT, 'shared', 'drift-history.json');
const STATE_PATH = path.join(ROOT, 'shared', 'map-state.json');
const TRACKING_PATH = path.join(ROOT, 'shared', 'tracking.json');
const MAX_SNAPSHOTS = 500;

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

function ensureHistoryFile() {
  const dirPath = path.dirname(HISTORY_PATH);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  if (!fs.existsSync(HISTORY_PATH)) {
    atomicWriteJson(HISTORY_PATH, { snapshots: [] });
  }

  if (!fs.existsSync(TRACKING_PATH)) {
    atomicWriteJson(TRACKING_PATH, {
      trackedPath: null,
      updatedAt: null,
    });
  }
}

function appendSnapshot(score, trigger, commitHash) {
  const history = safeReadJson(HISTORY_PATH, { snapshots: [] });
  const snapshots = Array.isArray(history.snapshots) ? history.snapshots : [];

  snapshots.push({
    timestamp: new Date().toISOString(),
    driftScore: score,
    trigger,
    commitHash: commitHash || null,
  });

  if (snapshots.length > MAX_SNAPSHOTS) {
    snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS);
  }

  atomicWriteJson(HISTORY_PATH, { snapshots });
}

ensureHistoryFile();

let lastScore = null;
const initialState = safeReadJson(STATE_PATH, { driftScore: null });
if (typeof initialState.driftScore === 'number') {
  lastScore = initialState.driftScore;
}

chokidar.watch(STATE_PATH, { ignoreInitial: true }).on('change', () => {
  try {
    const state = safeReadJson(STATE_PATH, { driftScore: null });
    if (typeof state.driftScore === 'number' && state.driftScore !== lastScore) {
      lastScore = state.driftScore;
      appendSnapshot(state.driftScore, 'state_change', null);
    }
  } catch (_) {
    // no-op
  }
});

let lastCommit = null;

setInterval(async () => {
  try {
    const trackedDir = getTrackedDir();
    let trackedDirAvailable = false;
    try {
      trackedDirAvailable = Boolean(trackedDir) && fs.existsSync(trackedDir) && fs.statSync(trackedDir).isDirectory();
    } catch (_) {
      trackedDirAvailable = false;
    }

    if (!trackedDirAvailable) {
      return;
    }

    const git = simpleGit(trackedDir);
    const log = await git.log({ maxCount: 1 });
    const hash = log.latest && log.latest.hash;
    if (!hash || hash === lastCommit) {
      return;
    }

    lastCommit = hash;
    const state = safeReadJson(STATE_PATH, { driftScore: null });
    const score =
      typeof state.driftScore === 'number'
        ? state.driftScore
        : typeof lastScore === 'number'
        ? lastScore
        : 0;

    if (typeof state.driftScore === 'number') {
      lastScore = state.driftScore;
    }

    appendSnapshot(score, 'commit', hash);
  } catch (_) {
    // output/ may not be a git repo yet
  }
}, 5000);
