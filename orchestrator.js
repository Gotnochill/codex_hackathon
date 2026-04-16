const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const ROOT = __dirname;
const SHARED_DIR = path.join(ROOT, 'shared');
const MAP_STATE_PATH = path.join(SHARED_DIR, 'map-state.json');
const PROMPT_PATH = path.join(SHARED_DIR, 'prompt.txt');
const DRIFT_HISTORY_PATH = path.join(SHARED_DIR, 'drift-history.json');
const HEAL_QUEUE_PATH = path.join(SHARED_DIR, 'heal-queue.json');
const ARCH_HEALTH_PATH = path.join(SHARED_DIR, 'arch-health.json');
const SETTINGS_PATH = path.join(SHARED_DIR, 'settings.json');
const TRACKING_PATH = path.join(SHARED_DIR, 'tracking.json');
const GENERATION_STATUS_PATH = path.join(SHARED_DIR, 'generation-status.json');
const ANALYZE_REQUEST_PATH = path.join(SHARED_DIR, 'analyze-request.json');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function initializeSharedState() {
  ensureDir(SHARED_DIR);

  if (!fs.existsSync(MAP_STATE_PATH)) {
    fs.writeFileSync(
      MAP_STATE_PATH,
      JSON.stringify({ nodes: [], edges: [], driftScore: null, lastUpdated: null }, null, 2)
    );
  }

  if (!fs.existsSync(PROMPT_PATH)) {
    fs.writeFileSync(PROMPT_PATH, '');
  }

  // Required startup initialization from design spec.
  fs.writeFileSync(DRIFT_HISTORY_PATH, JSON.stringify({ snapshots: [] }, null, 2));
  fs.writeFileSync(HEAL_QUEUE_PATH, JSON.stringify({ queue: [] }, null, 2));
  fs.writeFileSync(
    ARCH_HEALTH_PATH,
    JSON.stringify(
      {
        redNodeRatio: 0,
        depComplexity: 0,
        maxCyclomatic: 0,
        collapseScore: 0,
        warnings: [],
        destabilizing: false,
        lastUpdated: null,
      },
      null,
      2
    )
  );
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ autoHeal: false }, null, 2));

  if (!fs.existsSync(TRACKING_PATH)) {
    fs.writeFileSync(
      TRACKING_PATH,
      JSON.stringify({ trackedPath: null, updatedAt: null }, null, 2)
    );
  }

  if (!fs.existsSync(GENERATION_STATUS_PATH)) {
    fs.writeFileSync(
      GENERATION_STATUS_PATH,
      JSON.stringify(
        { running: false, done: false, startedAt: null, finishedAt: null, updatedAt: new Date().toISOString() },
        null,
        2
      )
    );
  }

  if (!fs.existsSync(ANALYZE_REQUEST_PATH)) {
    fs.writeFileSync(
      ANALYZE_REQUEST_PATH,
      JSON.stringify({ nonce: 0, requestedAt: null }, null, 2)
    );
  }
}

function startAgents() {
  const agents = [
    fork(path.join(ROOT, 'agents', 'cartographer.js')),
    fork(path.join(ROOT, 'agents', 'broadcaster.js')),
    fork(path.join(ROOT, 'agents', 'sentinel.js')),
    fork(path.join(ROOT, 'agents', 'historian.js')),
    fork(path.join(ROOT, 'agents', 'architect.js')),
    fork(path.join(ROOT, 'agents', 'healer.js')),
    fork(path.join(ROOT, 'agents', 'generator.js')),
  ];

  agents.forEach((child, idx) => {
    child.on('exit', (code, signal) => {
      const reason = signal || code;
      console.error(`[orchestrator] agent ${idx + 1} exited (${reason})`);
    });
  });

  const stopAll = () => {
    for (const child of agents) {
      if (!child.killed) child.kill('SIGTERM');
    }
  };

  process.on('SIGINT', () => {
    stopAll();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    stopAll();
    process.exit(0);
  });
}

initializeSharedState();
startAgents();
