const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const ROOT = path.resolve(__dirname, '..');
const SHARED_DIR = path.join(ROOT, 'shared');
const STATE_PATH = path.join(SHARED_DIR, 'map-state.json');
const TRACKING_PATH = path.join(SHARED_DIR, 'tracking.json');
const GENERATION_STATUS_PATH = path.join(SHARED_DIR, 'generation-status.json');
const ANALYZE_REQUEST_PATH = path.join(SHARED_DIR, 'analyze-request.json');
const DEBOUNCE_MS = 300;

let trackedDir = null;
let debounceTimer = null;
let rebuildQueuedWhileGenerating = false;
let pendingForceRebuild = false;
let lastHandledAnalyzeNonce = 0;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

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

function ensureSharedFiles() {
  ensureDir(SHARED_DIR);

  if (!fs.existsSync(STATE_PATH)) {
    atomicWriteJson(STATE_PATH, { nodes: [], edges: [], driftScore: null, lastUpdated: null });
  }

  if (!fs.existsSync(TRACKING_PATH)) {
    atomicWriteJson(TRACKING_PATH, { trackedPath: null, updatedAt: null });
  }

  if (!fs.existsSync(GENERATION_STATUS_PATH)) {
    atomicWriteJson(GENERATION_STATUS_PATH, {
      running: false,
      done: false,
      startedAt: null,
      finishedAt: null,
      updatedAt: new Date().toISOString(),
    });
  }

  if (!fs.existsSync(ANALYZE_REQUEST_PATH)) {
    atomicWriteJson(ANALYZE_REQUEST_PATH, { nonce: 0, requestedAt: null });
  }
}

function resolveTrackedDir() {
  const tracking = safeReadJson(TRACKING_PATH, {});
  const candidate =
    tracking && typeof tracking.trackedPath === 'string' && tracking.trackedPath.trim()
      ? path.resolve(String(tracking.trackedPath).trim())
      : null;

  if (!candidate) {
    return null;
  }

  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch (_) {
    return null;
  }

  return null;
}

function isGenerationRunning() {
  const status = safeReadJson(GENERATION_STATUS_PATH, { running: false });
  return Boolean(status && status.running === true);
}

function getAnalyzeNonce() {
  const request = safeReadJson(ANALYZE_REQUEST_PATH, { nonce: 0 });
  return Number(request.nonce || 0);
}

function normalizeId(absPath) {
  return path.relative(trackedDir, absPath).split(path.sep).join('/');
}

function listFilesRecursive(dirPath) {
  const out = [];
  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop();

    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  return out;
}

function resolveLocalImport(sourceFile, rawImport) {
  if (!trackedDir) return null;
  if (!rawImport || !rawImport.startsWith('.')) return null;

  const base = path.resolve(path.dirname(sourceFile), rawImport);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.js'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];

  for (const candidate of candidates) {
    if (candidate.startsWith(trackedDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return normalizeId(candidate);
    }
  }

  if (base.startsWith(trackedDir)) {
    return normalizeId(base);
  }

  return null;
}

function extractEdges(filePath, sourceId, code) {
  const edges = [];
  const edgeIds = new Set();

  const patterns = [
    /import\s+[^'"\n]+\s+from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[^'"\n]*from\s+['"]([^'"]+)['"]/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const targetId = resolveLocalImport(filePath, match[1]);
      if (!targetId) continue;

      const edgeId = `${sourceId}->${targetId}`;
      if (edgeIds.has(edgeId)) continue;

      edgeIds.add(edgeId);
      edges.push({ id: edgeId, source: sourceId, target: targetId });
    }
  }

  return edges;
}

function resetStateIfNeeded(previousState = null, forceWrite = false) {
  const previous =
    previousState ||
    safeReadJson(STATE_PATH, {
      nodes: [],
      edges: [],
      driftScore: null,
      lastUpdated: null,
    });

  const prevNodes = Array.isArray(previous.nodes) ? previous.nodes : [];
  const prevEdges = Array.isArray(previous.edges) ? previous.edges : [];

  if (!forceWrite && prevNodes.length === 0 && prevEdges.length === 0 && previous.driftScore == null) {
    return;
  }

  atomicWriteJson(STATE_PATH, {
    nodes: [],
    edges: [],
    driftScore: null,
    lastUpdated: new Date().toISOString(),
  });
}

function rebuildState(forceWrite = false) {
  const previous = safeReadJson(STATE_PATH, {
    nodes: [],
    edges: [],
    driftScore: null,
    lastUpdated: null,
  });

  if (!trackedDir) {
    resetStateIfNeeded(previous, forceWrite);
    return;
  }

  try {
    if (!fs.existsSync(trackedDir) || !fs.statSync(trackedDir).isDirectory()) {
      resetStateIfNeeded(previous, forceWrite);
      return;
    }
  } catch (_) {
    resetStateIfNeeded(previous, forceWrite);
    return;
  }

  const files = listFilesRecursive(trackedDir);
  const nodes = [];
  const edges = [];

  for (const filePath of files) {
    const id = normalizeId(filePath);

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      continue;
    }

    let code = '';
    try {
      code = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
      // Skip unreadable/binary files; map-state only tracks readable text nodes.
      continue;
    }

    nodes.push({
      id,
      label: id,
      type: 'file',
      path: id,
      grade: 'pending',
      score: null,
      code,
      size: stat.size,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
    });

    const fileEdges = extractEdges(filePath, id, code);
    edges.push(...fileEdges);
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));

  const nextState = {
    nodes,
    edges,
    driftScore: typeof previous.driftScore === 'number' ? previous.driftScore : null,
    lastUpdated: new Date().toISOString(),
  };

  if (!forceWrite) {
    const prevNodesJson = JSON.stringify(previous.nodes || []);
    const prevEdgesJson = JSON.stringify(previous.edges || []);
    const nextNodesJson = JSON.stringify(nextState.nodes);
    const nextEdgesJson = JSON.stringify(nextState.edges);

    if (prevNodesJson === nextNodesJson && prevEdgesJson === nextEdgesJson) {
      return;
    }
  }

  atomicWriteJson(STATE_PATH, nextState);
}

function scheduleRebuild(forceWrite = false) {
  if (forceWrite) {
    pendingForceRebuild = true;
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;

    if (isGenerationRunning()) {
      rebuildQueuedWhileGenerating = true;
      return;
    }

    const shouldForce = pendingForceRebuild;
    pendingForceRebuild = false;

    try {
      rebuildState(shouldForce);
      rebuildQueuedWhileGenerating = false;
    } catch (error) {
      console.error('[cartographer] rebuild failed:', error.message);
    }
  }, DEBOUNCE_MS);
}

function handleTrackingChange() {
  const nextTrackedDir = resolveTrackedDir();

  if (nextTrackedDir !== trackedDir) {
    trackedDir = nextTrackedDir;
    console.log(`[cartographer] tracking folder switched to ${trackedDir || '(unset)'}`);
  }

  // Do not auto-analyze on path change; require explicit Analyze click.
  resetStateIfNeeded();
}

function handleAnalyzeRequest() {
  const nonce = getAnalyzeNonce();
  if (nonce <= lastHandledAnalyzeNonce) {
    return;
  }

  lastHandledAnalyzeNonce = nonce;
  scheduleRebuild(true);
}

function flushQueuedRebuildIfGenerationFinished() {
  if (isGenerationRunning()) {
    return;
  }

  if (rebuildQueuedWhileGenerating) {
    scheduleRebuild(true);
  }
}

ensureSharedFiles();
trackedDir = resolveTrackedDir();
lastHandledAnalyzeNonce = getAnalyzeNonce();

chokidar.watch(TRACKING_PATH, {
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 120,
    pollInterval: 30,
  },
})
  .on('add', handleTrackingChange)
  .on('change', handleTrackingChange);

chokidar.watch(ANALYZE_REQUEST_PATH, {
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 120,
    pollInterval: 30,
  },
})
  .on('add', handleAnalyzeRequest)
  .on('change', handleAnalyzeRequest);

chokidar.watch(GENERATION_STATUS_PATH, {
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 120,
    pollInterval: 30,
  },
})
  .on('add', flushQueuedRebuildIfGenerationFinished)
  .on('change', flushQueuedRebuildIfGenerationFinished);
