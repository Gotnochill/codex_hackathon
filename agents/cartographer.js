const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const STATE_PATH = path.join(ROOT, 'shared', 'map-state.json');
const TRACKING_PATH = path.join(ROOT, 'shared', 'tracking.json');
const DEBOUNCE_MS = 300;
const ACTIVE_SCAN_MS = 3500;
let trackedDir = OUTPUT_DIR;
let fileWatcher = null;

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

function resolveTrackedDir() {
  const tracking = safeReadJson(TRACKING_PATH, {});
  const candidate =
    tracking && typeof tracking.trackedPath === 'string'
      ? path.resolve(String(tracking.trackedPath))
      : OUTPUT_DIR;

  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    return candidate;
  }

  return OUTPUT_DIR;
}

function normalizeId(absPath) {
  return path.relative(trackedDir, absPath).split(path.sep).join('/');
}

function listFilesRecursive(dirPath) {
  const out = [];
  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

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

function rebuildState() {
  if (!fs.existsSync(trackedDir)) {
    ensureDir(trackedDir);
  }

  const previous = safeReadJson(STATE_PATH, {
    nodes: [],
    edges: [],
    driftScore: null,
    lastUpdated: null,
  });
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));

  const files = listFilesRecursive(trackedDir);
  const nodes = [];
  const edges = [];

  for (const filePath of files) {
    const id = normalizeId(filePath);
    const stat = fs.statSync(filePath);
    const code = fs.readFileSync(filePath, 'utf8');
    const prev = previousNodes.get(id);
    const isChanged = !prev || prev.code !== code;

    nodes.push({
      id,
      label: id,
      type: 'file',
      path: id,
      grade: isChanged ? 'pending' : (prev.grade || 'pending'),
      score: isChanged ? null : (typeof prev.score === 'number' ? prev.score : null),
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

  const prevNodesJson = JSON.stringify(previous.nodes || []);
  const prevEdgesJson = JSON.stringify(previous.edges || []);
  const nextNodesJson = JSON.stringify(nextState.nodes);
  const nextEdgesJson = JSON.stringify(nextState.edges);

  if (prevNodesJson === nextNodesJson && prevEdgesJson === nextEdgesJson) {
    return;
  }

  atomicWriteJson(STATE_PATH, nextState);
}

let debounceTimer = null;
function scheduleRebuild() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    try {
      rebuildState();
    } catch (error) {
      console.error('[cartographer] rebuild failed:', error.message);
    }
  }, DEBOUNCE_MS);
}

ensureDir(path.join(ROOT, 'shared'));
if (!fs.existsSync(STATE_PATH)) {
  atomicWriteJson(STATE_PATH, { nodes: [], edges: [], driftScore: null, lastUpdated: null });
}

ensureDir(OUTPUT_DIR);
if (!fs.existsSync(TRACKING_PATH)) {
  atomicWriteJson(TRACKING_PATH, { trackedPath: OUTPUT_DIR, updatedAt: new Date().toISOString() });
}
trackedDir = resolveTrackedDir();

function startTrackedWatcher() {
  if (fileWatcher) {
    fileWatcher.close();
  }

  fileWatcher = chokidar.watch(trackedDir, {
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  fileWatcher
    .on('add', scheduleRebuild)
    .on('change', scheduleRebuild)
    .on('unlink', scheduleRebuild)
    .on('addDir', scheduleRebuild)
    .on('unlinkDir', scheduleRebuild)
    .on('ready', scheduleRebuild)
    .on('error', (error) => {
      console.error('[cartographer] watcher error:', error.message);
    });
}

startTrackedWatcher();

// Active polling fallback: rebuild every 3.5s so graph updates even if FS events are missed.
setInterval(() => {
  const nextTrackedDir = resolveTrackedDir();
  if (nextTrackedDir !== trackedDir) {
    trackedDir = nextTrackedDir;
    console.log(`[cartographer] tracking folder switched to ${trackedDir}`);
    startTrackedWatcher();
    return;
  }
  scheduleRebuild();
}, ACTIVE_SCAN_MS);

chokidar.watch(TRACKING_PATH, {
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 120,
    pollInterval: 30,
  },
}).on('change', () => {
  const nextTrackedDir = resolveTrackedDir();
  if (nextTrackedDir !== trackedDir) {
    trackedDir = nextTrackedDir;
    console.log(`[cartographer] tracking folder switched to ${trackedDir}`);
    startTrackedWatcher();
  } else {
    scheduleRebuild();
  }
});
