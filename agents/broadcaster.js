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
const GENERATION_STATUS_PATH = path.join(SHARED_DIR, 'generation-status.json');

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

function ensureSharedFiles() {
  ensureDir(SHARED_DIR);

  if (!fs.existsSync(MAP_STATE_PATH)) {
    atomicWriteJson(MAP_STATE_PATH, { nodes: [], edges: [], driftScore: null, lastUpdated: null });
  }

  if (!fs.existsSync(DRIFT_HISTORY_PATH)) {
    atomicWriteJson(DRIFT_HISTORY_PATH, { snapshots: [] });
  }

  if (!fs.existsSync(ARCH_HEALTH_PATH)) {
    atomicWriteJson(ARCH_HEALTH_PATH, {
      redNodeRatio: 0,
      depComplexity: 0,
      maxCyclomatic: 0,
      collapseScore: 0,
      warnings: [],
      destabilizing: false,
      lastUpdated: null,
    });
  }

  if (!fs.existsSync(HEAL_QUEUE_PATH)) {
    atomicWriteJson(HEAL_QUEUE_PATH, { queue: [] });
  }

  if (!fs.existsSync(SETTINGS_PATH)) {
    atomicWriteJson(SETTINGS_PATH, { autoHeal: false });
  }

  if (!fs.existsSync(GENERATION_STATUS_PATH)) {
    atomicWriteJson(GENERATION_STATUS_PATH, { done: false, finishedAt: null });
  }
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
  const rawPath = String((req && req.url) || '/').split('?')[0] || '/';

  if (rawPath === '/api/map-state') {
    const payload = safeReadJson(MAP_STATE_PATH, { nodes: [], edges: [], driftScore: null, lastUpdated: null });
    const settings = safeReadJson(SETTINGS_PATH, { autoHeal: false });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ...payload, autoHeal: Boolean(settings.autoHeal) }));
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

  return { nodes: changedNodes, edges: changedEdges };
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
  send(ws, 'full_reset', {
    ...fullState,
    autoHeal: Boolean(settings.autoHeal),
  });

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
let lastGenerationDone = false;

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

watcher.on('change', (changedPath) => {
  if (changedPath === MAP_STATE_PATH) {
    const nextState = safeReadJson(MAP_STATE_PATH, { nodes: [], edges: [], driftScore: null, lastUpdated: null });
    const delta = computeGraphDelta(lastState, nextState);

    if ((delta.nodes && delta.nodes.length > 0) || (delta.edges && delta.edges.length > 0)) {
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
    const status = safeReadJson(GENERATION_STATUS_PATH, { done: false, finishedAt: null });
    if (status.done && !lastGenerationDone) {
      broadcast('generation_done', { finishedAt: status.finishedAt || new Date().toISOString() });
    }
    lastGenerationDone = Boolean(status.done);
  }
});

watcher.on('error', (error) => {
  console.error('[broadcaster] watcher error:', error.message);
});
