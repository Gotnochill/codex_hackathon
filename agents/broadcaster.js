const fs = require('fs');
const path = require('path');
const http = require('http');
const chokidar = require('chokidar');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const SHARED_DIR = path.join(ROOT, 'shared');
const UI_DIR = path.join(ROOT, 'ui');
const MAP_STATE_PATH = path.join(SHARED_DIR, 'map-state.json');
const DRIFT_HISTORY_PATH = path.join(SHARED_DIR, 'drift-history.json');
const ARCH_HEALTH_PATH = path.join(SHARED_DIR, 'arch-health.json');
const HEAL_QUEUE_PATH = path.join(SHARED_DIR, 'heal-queue.json');
const SETTINGS_PATH = path.join(SHARED_DIR, 'settings.json');
const PROMPT_PATH = path.join(SHARED_DIR, 'prompt.txt');
const GENERATION_STATUS_PATH = path.join(SHARED_DIR, 'generation-status.json');
const TRACKING_PATH = path.join(SHARED_DIR, 'tracking.json');
const ANALYZE_REQUEST_PATH = path.join(SHARED_DIR, 'analyze-request.json');
const DEFAULT_BROWSE_ROOT = path.parse(ROOT).root;
const BROWSE_ROOT = path.resolve(process.env.CODEXMAP_BROWSE_ROOT || DEFAULT_BROWSE_ROOT);

const PORT = Number(process.env.PORT || process.env.WS_PORT || 4242);
const HOST = process.env.HOST || '0.0.0.0';

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

function send(ws, type, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, payload }));
}

function broadcast(type, payload) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type, payload }));
    }
  }
}

function emptyMapState() {
  return { nodes: [], edges: [], driftScore: null, lastUpdated: null };
}

function emptyDriftHistory() {
  return { snapshots: [] };
}

function emptyArchHealth() {
  return {
    redNodeRatio: 0,
    depComplexity: 0,
    maxCyclomatic: 0,
    collapseScore: 0,
    warnings: [],
    destabilizing: false,
    lastUpdated: null,
  };
}

function emptyQueue() {
  return { queue: [] };
}

function defaultSettings() {
  return { autoHeal: false };
}

function idleGenerationStatus() {
  return {
    running: false,
    done: false,
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function unsetTrackingPayload() {
  return { trackedPath: null, updatedAt: null };
}

function emptyAnalyzeRequest() {
  return { nonce: 0, requestedAt: null };
}

function ensureSharedFiles() {
  ensureDir(SHARED_DIR);

  if (!fs.existsSync(MAP_STATE_PATH)) {
    atomicWriteJson(MAP_STATE_PATH, emptyMapState());
  }

  if (!fs.existsSync(DRIFT_HISTORY_PATH)) {
    atomicWriteJson(DRIFT_HISTORY_PATH, emptyDriftHistory());
  }

  if (!fs.existsSync(ARCH_HEALTH_PATH)) {
    atomicWriteJson(ARCH_HEALTH_PATH, emptyArchHealth());
  }

  if (!fs.existsSync(HEAL_QUEUE_PATH)) {
    atomicWriteJson(HEAL_QUEUE_PATH, emptyQueue());
  }

  if (!fs.existsSync(SETTINGS_PATH)) {
    atomicWriteJson(SETTINGS_PATH, defaultSettings());
  }

  if (!fs.existsSync(PROMPT_PATH)) {
    fs.writeFileSync(PROMPT_PATH, '');
  }

  if (!fs.existsSync(GENERATION_STATUS_PATH)) {
    atomicWriteJson(GENERATION_STATUS_PATH, idleGenerationStatus());
  }

  if (!fs.existsSync(TRACKING_PATH)) {
    atomicWriteJson(TRACKING_PATH, unsetTrackingPayload());
  }

  if (!fs.existsSync(ANALYZE_REQUEST_PATH)) {
    atomicWriteJson(ANALYZE_REQUEST_PATH, emptyAnalyzeRequest());
  }
}

function resolveTrackingPayload() {
  const tracking = safeReadJson(TRACKING_PATH, { trackedPath: null, updatedAt: null });
  const trackedPath =
    tracking && typeof tracking.trackedPath === 'string' && tracking.trackedPath.trim()
      ? path.resolve(String(tracking.trackedPath).trim())
      : null;
  return {
    trackedPath,
    updatedAt: tracking.updatedAt || null,
  };
}

function resolveGenerationPayload() {
  const status = safeReadJson(GENERATION_STATUS_PATH, {
    running: false,
    done: false,
    startedAt: null,
    finishedAt: null,
    updatedAt: null,
  });

  return {
    running: Boolean(status.running),
    done: Boolean(status.done),
    startedAt: status.startedAt || null,
    finishedAt: status.finishedAt || null,
    updatedAt: status.updatedAt || null,
  };
}

function isPathInside(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveBrowsePath(rawPath) {
  let nextPath = null;
  if (typeof rawPath === 'string' && rawPath.trim()) {
    nextPath = path.resolve(rawPath.trim());
  } else {
    const tracked = resolveTrackingPayload().trackedPath;
    nextPath = tracked || BROWSE_ROOT;
  }

  if (!isPathInside(BROWSE_ROOT, nextPath)) {
    nextPath = BROWSE_ROOT;
  }

  return nextPath;
}

function listBrowseDirectories(rawPath) {
  const currentPath = resolveBrowsePath(rawPath);

  if (!fs.existsSync(currentPath)) {
    throw new Error('Folder does not exist');
  }

  const stats = fs.statSync(currentPath);
  if (!stats.isDirectory()) {
    throw new Error('Path is not a directory');
  }

  const directories = fs.readdirSync(currentPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(currentPath, entry.name);
      return {
        name: entry.name,
        path: fullPath,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const parentCandidate = path.dirname(currentPath);
  const parentPath =
    currentPath === BROWSE_ROOT
      ? null
      : (isPathInside(BROWSE_ROOT, parentCandidate) ? parentCandidate : BROWSE_ROOT);

  return {
    rootPath: BROWSE_ROOT,
    currentPath,
    parentPath,
    directories,
  };
}

function performReset() {
  const mapState = {
    ...emptyMapState(),
    lastUpdated: new Date().toISOString(),
  };
  const driftHistory = emptyDriftHistory();
  const archHealth = {
    ...emptyArchHealth(),
    lastUpdated: new Date().toISOString(),
  };
  const queue = emptyQueue();
  const settings = defaultSettings();
  const generation = idleGenerationStatus();
  const tracking = unsetTrackingPayload();
  const analyzeRequest = emptyAnalyzeRequest();

  atomicWriteJson(MAP_STATE_PATH, mapState);
  atomicWriteJson(DRIFT_HISTORY_PATH, driftHistory);
  atomicWriteJson(ARCH_HEALTH_PATH, archHealth);
  atomicWriteJson(HEAL_QUEUE_PATH, queue);
  atomicWriteJson(SETTINGS_PATH, settings);
  atomicWriteJson(GENERATION_STATUS_PATH, generation);
  atomicWriteJson(TRACKING_PATH, tracking);
  atomicWriteJson(ANALYZE_REQUEST_PATH, analyzeRequest);
  fs.writeFileSync(PROMPT_PATH, '');

  return {
    mapState,
    driftHistory,
    archHealth,
    queue,
    settings,
    generation,
    tracking,
    analyzeRequest,
  };
}

function triggerAnalyze() {
  const current = safeReadJson(ANALYZE_REQUEST_PATH, emptyAnalyzeRequest());
  const nonce = Number(current.nonce || 0) + 1;
  const payload = {
    nonce,
    requestedAt: new Date().toISOString(),
  };
  atomicWriteJson(ANALYZE_REQUEST_PATH, payload);
  return payload;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
      if (body.length > 512 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.ico') return 'image/x-icon';
  return 'application/octet-stream';
}

function serveUi(req, res) {
  const rawUrl = String((req && req.url) || '/');
  const [urlPath, queryString = ''] = rawUrl.split('?');
  const rawPath = urlPath || '/';
  const query = new URLSearchParams(queryString);

  if (rawPath === '/api/map-state') {
    const payload = safeReadJson(MAP_STATE_PATH, { nodes: [], edges: [], driftScore: null, lastUpdated: null });
    const settings = safeReadJson(SETTINGS_PATH, { autoHeal: false });
    const tracking = resolveTrackingPayload();
    const generation = resolveGenerationPayload();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        ...payload,
        autoHeal: Boolean(settings.autoHeal),
        trackedPath: tracking.trackedPath,
        generation,
      })
    );
    return;
  }

  if (rawPath === '/api/tracking' && req.method === 'GET') {
    const tracking = resolveTrackingPayload();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(tracking));
    return;
  }

  if (rawPath === '/api/tracking' && req.method === 'POST') {
    readRequestBody(req)
      .then((body) => {
        let data = {};
        try {
          data = JSON.parse(body || '{}');
        } catch (_) {
          res.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
          return;
        }

        const rawInput = typeof data.path === 'string' ? data.path.trim() : '';
        if (!rawInput) {
          res.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ ok: false, error: 'Path is required' }));
          return;
        }

        const nextPath = path.resolve(rawInput);
        try {
          fs.mkdirSync(nextPath, { recursive: true });
        } catch (error) {
          res.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ ok: false, error: `Unable to access path: ${error.message}` }));
          return;
        }

        const payload = {
          trackedPath: nextPath,
          updatedAt: new Date().toISOString(),
        };
        atomicWriteJson(TRACKING_PATH, payload);

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: true, ...payload }));
      })
      .catch((error) => {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: false, error: error.message || 'Failed to update tracking path' }));
      });
    return;
  }

  if (rawPath === '/api/folders' && req.method === 'GET') {
    try {
      const requestedPath = query.get('path');
      const payload = listBrowseDirectories(requestedPath);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, ...payload }));
    } catch (error) {
      res.writeHead(400, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: false, error: error.message || 'Unable to browse folder' }));
    }
    return;
  }

  if (rawPath === '/api/reset' && req.method === 'POST') {
    try {
      const payload = performReset();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, ...payload }));
    } catch (error) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: false, error: error.message || 'Failed to reset state' }));
    }
    return;
  }

  if (rawPath === '/api/analyze' && req.method === 'POST') {
    const tracking = resolveTrackingPayload();
    if (!tracking.trackedPath) {
      res.writeHead(400, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: false, error: 'Tracking path is not set' }));
      return;
    }

    try {
      const analyzeRequest = triggerAnalyze();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, analyzeRequest }));
    } catch (error) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: false, error: error.message || 'Failed to trigger analyze' }));
    }
    return;
  }

  if (rawPath === '/api/drift-history') {
    const payload = safeReadJson(DRIFT_HISTORY_PATH, { snapshots: [] });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
    return;
  }

  if (rawPath === '/api/arch-health') {
    const payload = safeReadJson(ARCH_HEALTH_PATH, {
      redNodeRatio: 0,
      depComplexity: 0,
      maxCyclomatic: 0,
      collapseScore: 0,
      warnings: [],
      destabilizing: false,
      lastUpdated: null,
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
    return;
  }

  if (rawPath === '/healthz') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end('ok');
    return;
  }

  let requestPath = rawPath === '/' ? '/index.html' : rawPath;
  if (requestPath.endsWith('/')) {
    requestPath += 'index.html';
  }

  const resolvedPath = path.normalize(path.join(UI_DIR, requestPath));
  if (!resolvedPath.startsWith(UI_DIR)) {
    res.writeHead(403, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end('Forbidden');
    return;
  }

  let filePath = resolvedPath;
  if (!fs.existsSync(filePath)) {
    // Single-page fallback for unknown routes.
    filePath = path.join(UI_DIR, 'index.html');
  } else if (fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end('Not Found');
    return;
  }

  try {
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (_) {
    res.writeHead(500, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end('Internal Server Error');
  }
}

function mapById(items) {
  const map = new Map();
  for (const item of items) {
    map.set(item.id, item);
  }
  return map;
}

function shallowEqualNode(a, b) {
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.type === b.type &&
    a.path === b.path &&
    a.grade === b.grade &&
    a.score === b.score &&
    a.updatedAt === b.updatedAt &&
    a.size === b.size
  );
}

function computeGraphDelta(prevState, nextState) {
  const prevNodes = mapById(prevState.nodes || []);
  const nextNodes = mapById(nextState.nodes || []);

  const changedNodes = [];
  for (const [id, node] of nextNodes.entries()) {
    const prev = prevNodes.get(id);
    if (!prev || !shallowEqualNode(prev, node)) {
      changedNodes.push(node);
    }
  }

  const prevEdges = new Map((prevState.edges || []).map((edge) => [edge.id, edge]));
  const nextEdges = new Map((nextState.edges || []).map((edge) => [edge.id, edge]));

  const changedEdges = [];
  for (const [id, edge] of nextEdges.entries()) {
    const prev = prevEdges.get(id);
    if (!prev || prev.source !== edge.source || prev.target !== edge.target) {
      changedEdges.push(edge);
    }
  }

  const removedNodeIds = [];
  for (const id of prevNodes.keys()) {
    if (!nextNodes.has(id)) removedNodeIds.push(id);
  }

  const removedEdgeIds = [];
  for (const id of prevEdges.keys()) {
    if (!nextEdges.has(id)) removedEdgeIds.push(id);
  }

  return { nodes: changedNodes, edges: changedEdges, removedNodeIds, removedEdgeIds };
}

function emitNodeGradeUpdates(prevState, nextState) {
  const prevNodes = mapById(prevState.nodes || []);
  for (const node of nextState.nodes || []) {
    const prev = prevNodes.get(node.id);
    const scoreChanged = (prev ? prev.score : null) !== node.score;
    const gradeChanged = (prev ? prev.grade : null) !== node.grade;

    if (scoreChanged || gradeChanged) {
      broadcast('node_grade', {
        id: node.id,
        grade: node.grade,
        score: typeof node.score === 'number' ? node.score : null,
      });
    }
  }
}

function upsertManualHeal(nodeId) {
  if (!nodeId || typeof nodeId !== 'string') return;

  const queue = safeReadJson(HEAL_QUEUE_PATH, { queue: [] });
  const exists = queue.queue.some((entry) => entry.nodeId === nodeId);
  if (exists) return;

  const state = safeReadJson(MAP_STATE_PATH, { nodes: [] });
  const node = (state.nodes || []).find((candidate) => candidate.id === nodeId);

  queue.queue.push({
    nodeId,
    status: 'pending',
    triggeredBy: 'manual',
    enqueuedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    attemptCount: 0,
    lastScore: typeof node?.score === 'number' ? node.score : 0,
    reanchorOutputFlag: true,
  });

  atomicWriteJson(HEAL_QUEUE_PATH, queue);
}

ensureSharedFiles();

const server = http.createServer(serveUi);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[broadcaster] serving ui+ws on http://${HOST}:${PORT}`);
});

wss.on('connection', (ws) => {
  const fullState = safeReadJson(MAP_STATE_PATH, { nodes: [], edges: [], driftScore: null, lastUpdated: null });
  const settings = safeReadJson(SETTINGS_PATH, { autoHeal: false });
  const tracking = resolveTrackingPayload();
  const generation = resolveGenerationPayload();
  send(ws, 'full_reset', {
    ...fullState,
    autoHeal: Boolean(settings.autoHeal),
    trackedPath: tracking.trackedPath,
    generation,
  });
  send(ws, 'generation_status', generation);

  const driftHistory = safeReadJson(DRIFT_HISTORY_PATH, { snapshots: [] });
  send(ws, 'full_drift_history', driftHistory);

  const archHealth = safeReadJson(ARCH_HEALTH_PATH, {
    redNodeRatio: 0,
    depComplexity: 0,
    maxCyclomatic: 0,
    collapseScore: 0,
    warnings: [],
    destabilizing: false,
    lastUpdated: null,
  });
  send(ws, 'full_arch_health', archHealth);

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch (_) {
      return;
    }

    if (message?.type === 'set_autoheal') {
      const enabled =
        typeof message.enabled === 'boolean'
          ? message.enabled
          : Boolean(message.payload && message.payload.enabled);
      atomicWriteJson(SETTINGS_PATH, { autoHeal: enabled });
      return;
    }

    if (message?.type === 'manual_heal') {
      const nodeId =
        typeof message.nodeId === 'string'
          ? message.nodeId
          : message.payload && typeof message.payload.nodeId === 'string'
          ? message.payload.nodeId
          : null;
      upsertManualHeal(nodeId);
    }
  });
});

let lastState = safeReadJson(MAP_STATE_PATH, { nodes: [], edges: [], driftScore: null, lastUpdated: null });
let lastQueue = safeReadJson(HEAL_QUEUE_PATH, { queue: [] });
const initialGenerationStatus = resolveGenerationPayload();
let lastGenerationDone = initialGenerationStatus.done;
let lastGenerationRunning = initialGenerationStatus.running;

const watcher = chokidar.watch(
  [MAP_STATE_PATH, DRIFT_HISTORY_PATH, ARCH_HEALTH_PATH, HEAL_QUEUE_PATH, GENERATION_STATUS_PATH],
  {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 25,
    },
  }
);

function handleSharedStateChange(changedPath) {
  if (changedPath === MAP_STATE_PATH) {
    const nextState = safeReadJson(MAP_STATE_PATH, { nodes: [], edges: [], driftScore: null, lastUpdated: null });
    const delta = computeGraphDelta(lastState, nextState);

    if (
      (delta.nodes && delta.nodes.length > 0) ||
      (delta.edges && delta.edges.length > 0) ||
      (delta.removedNodeIds && delta.removedNodeIds.length > 0) ||
      (delta.removedEdgeIds && delta.removedEdgeIds.length > 0)
    ) {
      broadcast('graph_update', delta);
    }

    emitNodeGradeUpdates(lastState, nextState);
    lastState = nextState;
    return;
  }

  if (changedPath === DRIFT_HISTORY_PATH) {
    const payload = safeReadJson(DRIFT_HISTORY_PATH, { snapshots: [] });
    broadcast('drift_history_update', payload);
    return;
  }

  if (changedPath === ARCH_HEALTH_PATH) {
    const payload = safeReadJson(ARCH_HEALTH_PATH, {
      redNodeRatio: 0,
      depComplexity: 0,
      maxCyclomatic: 0,
      collapseScore: 0,
      warnings: [],
      destabilizing: false,
      lastUpdated: null,
    });
    broadcast('arch_health_update', payload);
    return;
  }

  if (changedPath === HEAL_QUEUE_PATH) {
    const nextQueue = safeReadJson(HEAL_QUEUE_PATH, { queue: [] });
    const prevByNode = new Map((lastQueue.queue || []).map((entry) => [entry.nodeId, entry.status]));

    for (const entry of nextQueue.queue || []) {
      const prevStatus = prevByNode.get(entry.nodeId);
      if (prevStatus !== entry.status) {
        broadcast('heal_status_update', {
          nodeId: entry.nodeId,
          status: entry.status,
        });
      }
    }

    lastQueue = nextQueue;
    return;
  }

  if (changedPath === GENERATION_STATUS_PATH) {
    const status = resolveGenerationPayload();
    if (status.running !== lastGenerationRunning) {
      broadcast('generation_status', status);
    }
    if (status.done && !lastGenerationDone) {
      broadcast('generation_done', { finishedAt: status.finishedAt || new Date().toISOString() });
    }
    lastGenerationDone = Boolean(status.done);
    lastGenerationRunning = Boolean(status.running);
  }
}

watcher.on('add', handleSharedStateChange);
watcher.on('change', handleSharedStateChange);
watcher.on('unlink', handleSharedStateChange);

watcher.on('error', (error) => {
  console.error('[broadcaster] watcher error:', error.message);
});
