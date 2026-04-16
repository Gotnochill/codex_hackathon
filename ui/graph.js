import { DriftChart, clampScore } from './drift-chart.js';
import { PanelController } from './panel.js';

const SERVER_MESSAGE_TYPES = new Set([
  'graph_update',
  'node_grade',
  'full_reset',
  'generation_done',
  'drift_history_update',
  'full_drift_history',
  'arch_health_update',
  'full_arch_health',
  'heal_status_update',
]);

const CLIENT_MESSAGE_TYPES = new Set([
  'set_autoheal',
  'manual_heal',
]);

const ARCH_DEFAULT = {
  redNodeRatio: 0,
  depComplexity: 0,
  maxCyclomatic: 0,
  collapseScore: 0,
  warnings: [],
  destabilizing: false,
  lastUpdated: null,
};

const METER_RADIUS = 26;
const METER_CIRCUMFERENCE = 2 * Math.PI * METER_RADIUS;
const HTTP_SYNC_MS = 2500;

const appState = {
  socket: null,
  reconnectAttempt: 0,
  nodes: new Map(),
  edges: new Map(),
  healStatuses: new Map(),
  selectedNodeId: null,
  lastArchBannerKey: '',
  dismissedArchBannerKey: '',
  cy: null,
  fallbackMode: false,
  hasLaidOutGraph: false,
  pollingInFlight: false,
};

const dom = {
  graphContainer: document.getElementById('graph-container'),
  nodeFeedCount: document.getElementById('node-feed-count'),
  nodeFeedList: document.getElementById('node-feed-list'),
  driftScoreBadge: document.getElementById('drift-score-badge'),
  autoHealToggle: document.getElementById('autoheal-toggle'),
  archHealthMeter: document.getElementById('arch-health-meter'),
  archMeterProgress: document.getElementById('arch-meter-progress'),
  archHealthValue: document.getElementById('arch-health-value'),
  connectionStatus: document.getElementById('connection-status'),
  generationStatus: document.getElementById('generation-status'),
  archWarningBanner: document.getElementById('arch-warning-banner'),
  archWarningText: document.getElementById('arch-warning-text'),
  dismissArchWarningButton: document.getElementById('dismiss-arch-warning'),
};

const driftChart = new DriftChart({
  svgEl: document.getElementById('drift-sparkline'),
  trendLabelEl: document.getElementById('drift-trend-label'),
  bannerEl: document.getElementById('drift-warning-banner'),
  dismissButtonEl: document.getElementById('dismiss-drift-warning'),
});

const panelController = new PanelController({
  onManualHeal: (nodeId) => {
    sendMessage({ type: 'manual_heal', nodeId: String(nodeId) });
  },
  onHealAll: (nodeIds) => {
    nodeIds.forEach((nodeId) => {
      sendMessage({ type: 'manual_heal', nodeId: String(nodeId) });
    });
  },
  onNodePanelClosed: () => {
    appState.selectedNodeId = null;
    if (appState.cy) appState.cy.$('node:selected').unselect();
    else renderFallbackGraph();
  },
  getAllNodes: () => Array.from(appState.nodes.values()),
});

if (dom.archMeterProgress) {
  dom.archMeterProgress.style.strokeDasharray = String(METER_CIRCUMFERENCE);
}

if (dom.dismissArchWarningButton) {
  dom.dismissArchWarningButton.addEventListener('click', () => {
    appState.dismissedArchBannerKey = appState.lastArchBannerKey;
    if (dom.archWarningBanner) dom.archWarningBanner.classList.add('is-hidden');
  });
}

if (dom.autoHealToggle) {
  dom.autoHealToggle.addEventListener('change', () => {
    sendMessage({ type: 'set_autoheal', enabled: Boolean(dom.autoHealToggle.checked) });
  });
}

if (dom.archHealthMeter) {
  dom.archHealthMeter.addEventListener('click', () => {
    panelController.openArchitectureDrawer();
  });
}

appState.cy = initGraph();
setConnectionStatus('disconnected');
updateArchHealthUI(ARCH_DEFAULT);
connectWebSocket();
startHttpSyncLoop();

function initGraph() {
  if (!dom.graphContainer) {
    setGenerationStatus('Graph container unavailable');
    renderNodeFeed();
    return null;
  }

  if (typeof window.cytoscape !== 'function') {
    appState.fallbackMode = true;
    dom.graphContainer.classList.add('graph-fallback-mode');
    setGenerationStatus('Cytoscape unavailable - using fallback node list');
    renderFallbackGraph();
    return null;
  }

  const cy = window.cytoscape({
    container: dom.graphContainer,
    elements: [],
    layout: { name: 'grid', fit: true, padding: 28 },
    style: [
      {
        selector: 'node',
        css: {
          label: 'data(label)',
          'text-wrap': 'ellipsis',
          'text-max-width': 130,
          'font-size': 10,
          color: '#ffffff',
          'text-outline-color': '#0f172a',
          'text-outline-width': 1,
          'text-valign': 'center',
          'text-halign': 'center',
          'background-color': '#94a3b8',
          'border-width': 1,
          'border-color': '#cbd5e1',
          width: 44,
          height: 44,
        },
      },
      { selector: 'node[grade = "green"]', css: { 'background-color': '#22c55e' } },
      { selector: 'node[grade = "yellow"]', css: { 'background-color': '#f59e0b' } },
      { selector: 'node[grade = "red"]', css: { 'background-color': '#ef4444' } },
      { selector: 'node[grade = "pending"]', css: { 'background-color': '#64748b' } },
      {
        selector: 'node:selected',
        css: {
          'border-color': '#0369a1',
          'border-width': 3,
        },
      },
      {
        selector: 'edge',
        css: {
          width: 1.5,
          'line-color': '#cbd5e1',
          'target-arrow-color': '#cbd5e1',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
        },
      },
      {
        selector: 'node[healStatus = "healing"]',
        css: {
          'border-color': '#a78bfa',
          'border-width': 4,
          'border-style': 'dashed',
        },
      },
      {
        selector: 'node[healStatus = "done"]',
        css: {
          'border-color': '#22c55e',
          'border-width': 2,
        },
      },
      {
        selector: 'node[healStatus = "failed"]',
        css: {
          'border-color': '#ef4444',
          'border-width': 2,
          'border-style': 'dotted',
        },
      },
    ],
  });

  cy.on('tap', 'node', (event) => {
    const nodeId = event.target.id();
    appState.selectedNodeId = nodeId;
    const node = appState.nodes.get(nodeId) || null;
    panelController.setNode(node);
  });

  return cy;
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const isHttpPage = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  const host = isHttpPage
    ? window.location.host
    : 'localhost:4242';
  const url = `${protocol}://${host}`;

  setConnectionStatus('connecting');
  const socket = new WebSocket(url);
  appState.socket = socket;

  socket.addEventListener('open', () => {
    appState.reconnectAttempt = 0;
    setConnectionStatus('connected');
    setGenerationStatus('Generation running');
  });

  socket.addEventListener('message', (event) => {
    handleServerMessage(event.data);
  });

  socket.addEventListener('close', () => {
    if (appState.socket !== socket) return;
    setConnectionStatus('disconnected');
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    setConnectionStatus('error');
  });
}

function scheduleReconnect() {
  appState.reconnectAttempt += 1;
  const delay = Math.min(10_000, 800 * (2 ** Math.min(appState.reconnectAttempt, 4)));
  window.setTimeout(() => {
    connectWebSocket();
  }, delay);
}

function startHttpSyncLoop() {
  pollServerState();
  window.setInterval(() => {
    pollServerState();
  }, HTTP_SYNC_MS);
}

async function pollServerState() {
  if (appState.pollingInFlight) return;
  appState.pollingInFlight = true;
  try {
    const [stateRes, driftRes, archRes] = await Promise.all([
      fetch('/api/map-state', { cache: 'no-store' }),
      fetch('/api/drift-history', { cache: 'no-store' }),
      fetch('/api/arch-health', { cache: 'no-store' }),
    ]);

    if (stateRes.ok) {
      const state = await stateRes.json();
      applyFullReset(state);
    }

    if (driftRes.ok) {
      const drift = await driftRes.json();
      applyDriftHistory(drift);
    }

    if (archRes.ok) {
      const arch = await archRes.json();
      applyArchHealth(arch);
    }
  } catch (_) {
    // Keep websocket path as primary; polling is a robustness fallback.
  } finally {
    appState.pollingInFlight = false;
  }
}

function sendMessage(message) {
  if (!message || !CLIENT_MESSAGE_TYPES.has(message.type)) return;
  if (!appState.socket || appState.socket.readyState !== WebSocket.OPEN) return;
  appState.socket.send(JSON.stringify(message));
}

function handleServerMessage(rawData) {
  let message;
  try {
    message = JSON.parse(rawData);
  } catch (_) {
    return;
  }

  if (Array.isArray(message)) {
    applyGraphUpdate(message);
    return;
  }

  if (!message || typeof message !== 'object') return;

  if (!message.type && (Array.isArray(message.nodes) || Array.isArray(message.edges))) {
    applyFullReset(message);
    return;
  }

  if (!SERVER_MESSAGE_TYPES.has(message.type)) return;

  const payload = Object.prototype.hasOwnProperty.call(message, 'payload')
    ? message.payload
    : message;

  switch (message.type) {
    case 'graph_update':
      applyGraphUpdate(payload);
      break;
    case 'node_grade':
      applyNodeGrade(payload);
      break;
    case 'full_reset':
      applyFullReset(payload);
      break;
    case 'generation_done':
      setGenerationDone();
      break;
    case 'drift_history_update':
    case 'full_drift_history':
      applyDriftHistory(payload);
      break;
    case 'arch_health_update':
    case 'full_arch_health':
      applyArchHealth(payload);
      break;
    case 'heal_status_update':
      applyHealStatus(payload);
      break;
    default:
      break;
  }
}

function parseGraphUpdatePayload(payload) {
  const parsed = {
    nodes: [],
    edges: [],
    removedNodeIds: [],
    removedEdgeIds: [],
    driftScore: null,
  };

  if (payload == null) return parsed;

  if (Array.isArray(payload)) {
    payload.forEach((item) => {
      const nested = parseGraphUpdatePayload(item);
      parsed.nodes.push(...nested.nodes);
      parsed.edges.push(...nested.edges);
      parsed.removedNodeIds.push(...nested.removedNodeIds);
      parsed.removedEdgeIds.push(...nested.removedEdgeIds);
      if (Number.isFinite(nested.driftScore)) parsed.driftScore = nested.driftScore;
    });
    return parsed;
  }

  if (typeof payload !== 'object') return parsed;

  if (Number.isFinite(payload.driftScore)) parsed.driftScore = Number(payload.driftScore);

  if (Array.isArray(payload.nodes)) parsed.nodes.push(...payload.nodes);
  if (Array.isArray(payload.edges)) parsed.edges.push(...payload.edges);
  if (Array.isArray(payload.removedNodeIds)) {
    parsed.removedNodeIds.push(...payload.removedNodeIds.map((id) => String(id)));
  }
  if (Array.isArray(payload.removedEdgeIds)) {
    parsed.removedEdgeIds.push(...payload.removedEdgeIds.map((id) => String(id)));
  }

  if (payload.remove === true || payload.op === 'remove') {
    if (looksLikeEdge(payload)) {
      const edge = normalizeEdge(payload);
      if (edge) parsed.removedEdgeIds.push(edge.id);
    } else if (payload.id || payload.nodeId) {
      parsed.removedNodeIds.push(String(payload.id || payload.nodeId));
    }
    return parsed;
  }

  if (looksLikeEdge(payload)) {
    parsed.edges.push(payload);
    return parsed;
  }

  if (looksLikeNode(payload)) {
    parsed.nodes.push(payload);
  }

  return parsed;
}

function applyFullReset(rawState) {
  const state = (rawState && typeof rawState === 'object') ? rawState : {};
  const nodeList = Array.isArray(state.nodes) ? state.nodes : [];
  const edgeList = Array.isArray(state.edges) ? state.edges : [];

  appState.nodes.clear();
  appState.edges.clear();
  if (appState.cy) appState.cy.elements().remove();

  const elements = [];
  nodeList.forEach((rawNode) => {
    const node = normalizeNode(rawNode);
    if (!node) return;
    appState.nodes.set(node.id, node);
    elements.push({ group: 'nodes', data: node });
  });

  edgeList.forEach((rawEdge) => {
    const edge = normalizeEdge(rawEdge);
    if (!edge) return;
    appState.edges.set(edge.id, edge);
    elements.push({ group: 'edges', data: edge });
  });

  if (appState.cy && elements.length > 0) {
    try {
      appState.cy.add(elements);
    } catch (err) {
      console.error('[graph] cy.add failed:', err);
      appState.cy = null;
      appState.fallbackMode = true;
      if (dom.graphContainer) dom.graphContainer.classList.add('graph-fallback-mode');
      setGenerationStatus('Graph fallback mode active');
    }
  }

  if (appState.cy) {
    // Always run layout on full reset so nodes are positioned correctly
    runLayout(appState.hasLaidOutGraph);
    appState.hasLaidOutGraph = true;
  } else {
    renderFallbackGraph();
  }
  renderNodeFeed();

  if (Number.isFinite(state.driftScore)) {
    setDriftScoreBadge(Number(state.driftScore));
  }

  if (state.settings && typeof state.settings.autoHeal === 'boolean' && dom.autoHealToggle) {
    dom.autoHealToggle.checked = state.settings.autoHeal;
  }
  if (typeof state.autoHeal === 'boolean' && dom.autoHealToggle) {
    dom.autoHealToggle.checked = state.autoHeal;
  }

  if (state.archHealth && typeof state.archHealth === 'object') {
    applyArchHealth(state.archHealth);
  } else {
    updateArchHealthUI(ARCH_DEFAULT);
  }

  panelController.refresh();
  refreshSelectedNode();
}

function applyGraphUpdate(payload) {
  const parsed = parseGraphUpdatePayload(payload);

  parsed.removedNodeIds.forEach((nodeId) => {
    appState.nodes.delete(nodeId);
    if (appState.cy) {
      const node = appState.cy.getElementById(nodeId);
      if (node.length) node.remove();
    }
  });

  parsed.removedEdgeIds.forEach((edgeId) => {
    appState.edges.delete(edgeId);
    if (appState.cy) {
      const edge = appState.cy.getElementById(edgeId);
      if (edge.length) edge.remove();
    }
  });

  let addedElements = 0;

  parsed.nodes.forEach((rawNode) => {
    const node = normalizeNode(rawNode);
    if (!node) return;
    const hadNode = appState.nodes.has(node.id);
    appState.nodes.set(node.id, node);
    if (appState.cy) {
      try {
        const existing = appState.cy.getElementById(node.id);
        if (existing.length > 0) {
          existing.data(node);
        } else {
          appState.cy.add({ group: 'nodes', data: node });
          addedElements += 1;
        }
      } catch (_) {
        appState.cy = null;
        appState.fallbackMode = true;
        if (dom.graphContainer) dom.graphContainer.classList.add('graph-fallback-mode');
      }
    }
    if (!hadNode) addedElements += 1;
  });

  parsed.edges.forEach((rawEdge) => {
    const edge = normalizeEdge(rawEdge);
    if (!edge) return;
    const hadEdge = appState.edges.has(edge.id);
    appState.edges.set(edge.id, edge);
    if (appState.cy) {
      try {
        const existing = appState.cy.getElementById(edge.id);
        if (existing.length > 0) {
          existing.data(edge);
        } else {
          appState.cy.add({ group: 'edges', data: edge });
          addedElements += 1;
        }
      } catch (_) {
        appState.cy = null;
        appState.fallbackMode = true;
        if (dom.graphContainer) dom.graphContainer.classList.add('graph-fallback-mode');
      }
    }
    if (!hadEdge) addedElements += 1;
  });

  if (Number.isFinite(parsed.driftScore)) {
    setDriftScoreBadge(parsed.driftScore);
  }

  if (appState.cy && addedElements > 0) {
    runLayout(appState.hasLaidOutGraph);
    appState.hasLaidOutGraph = true;
  }
  if (!appState.cy) renderFallbackGraph();
  renderNodeFeed();

  panelController.refresh();
  refreshSelectedNode();
}

function applyNodeGrade(payload) {
  if (!payload || typeof payload !== 'object') return;
  const nodeId = String(payload.id || payload.nodeId || '');
  if (!nodeId) return;

  const current = appState.nodes.get(nodeId) || { id: nodeId };
  const next = normalizeNode({
    ...current,
    id: nodeId,
    grade: payload.grade ?? current.grade,
    score: Number.isFinite(payload.score) ? payload.score : current.score,
  });

  if (!next) return;
  appState.nodes.set(next.id, next);
  if (appState.cy) {
    try {
      const existing = appState.cy.getElementById(next.id);
      if (existing.length > 0) existing.data(next);
    } catch (_) {
      appState.cy = null;
      appState.fallbackMode = true;
      if (dom.graphContainer) dom.graphContainer.classList.add('graph-fallback-mode');
    }
  }
  if (!appState.cy) renderFallbackGraph();
  renderNodeFeed();

  panelController.refresh();
  refreshSelectedNode();
}

function applyHealStatus(payload) {
  if (!payload || typeof payload !== 'object') return;
  const nodeId = String(payload.nodeId || payload.id || '');
  if (!nodeId) return;

  const status = payload.status ? String(payload.status) : '';
  if (status) appState.healStatuses.set(nodeId, status);
  else appState.healStatuses.delete(nodeId);

  const node = appState.nodes.get(nodeId);
  if (node) {
    const next = normalizeNode({ ...node, healStatus: status });
    appState.nodes.set(nodeId, next);
    if (appState.cy) {
      const existing = appState.cy.getElementById(nodeId);
      if (existing.length > 0) existing.data(next);
    }
  }
  if (!appState.cy) renderFallbackGraph();
  renderNodeFeed();

  panelController.refresh();
  refreshSelectedNode();
}

function applyDriftHistory(payload) {
  const snapshots = Array.isArray(payload?.snapshots)
    ? payload.snapshots
    : (Array.isArray(payload) ? payload : []);

  driftChart.setSnapshots(snapshots);
  if (snapshots.length > 0) {
    const latest = snapshots[snapshots.length - 1];
    if (Number.isFinite(Number(latest?.driftScore))) {
      setDriftScoreBadge(Number(latest.driftScore));
    }
  }
}

function applyArchHealth(payload) {
  const health = {
    ...ARCH_DEFAULT,
    ...(payload && typeof payload === 'object' ? payload : {}),
  };
  health.redNodeRatio = Number.isFinite(health.redNodeRatio) ? health.redNodeRatio : 0;
  health.depComplexity = Number.isFinite(health.depComplexity) ? health.depComplexity : 0;
  health.maxCyclomatic = Number.isFinite(health.maxCyclomatic) ? health.maxCyclomatic : 0;
  health.collapseScore = Number.isFinite(health.collapseScore) ? health.collapseScore : 0;
  health.warnings = Array.isArray(health.warnings) ? health.warnings : [];
  health.destabilizing = Boolean(health.destabilizing);

  updateArchHealthUI(health);
}

function updateArchHealthUI(health) {
  const collapseScore = clampScore(Number(health.collapseScore));
  const archHealth = clampScore(100 - collapseScore);

  if (dom.archHealthValue) {
    dom.archHealthValue.textContent = String(Math.round(archHealth));
  }

  if (dom.archMeterProgress) {
    const ratio = archHealth / 100;
    const offset = METER_CIRCUMFERENCE * (1 - ratio);
    dom.archMeterProgress.style.strokeDashoffset = String(offset);

    let color = '#ef4444';
    if (archHealth >= 70) color = '#22c55e';
    else if (archHealth >= 40) color = '#f59e0b';
    dom.archMeterProgress.style.stroke = color;
  }

  panelController.setArchitectureHealth(health);
  renderArchitectureBanner(health);
}

function renderArchitectureBanner(health) {
  if (!dom.archWarningBanner || !dom.archWarningText) return;
  const warnings = Array.isArray(health.warnings) ? health.warnings : [];
  const sentences = warnings
    .map((warning) => String(warning?.message || '').trim())
    .filter(Boolean);

  const message = `🏚️ Architecture destabilizing.${sentences.length ? ` ${sentences.join(' ')}` : ''}`;
  const bannerKey = `${health.lastUpdated || ''}|${message}`;
  appState.lastArchBannerKey = bannerKey;

  if (!health.destabilizing || appState.dismissedArchBannerKey === bannerKey) {
    dom.archWarningBanner.classList.add('is-hidden');
    return;
  }

  dom.archWarningText.textContent = message;
  dom.archWarningBanner.classList.remove('is-hidden');
}

function refreshSelectedNode() {
  if (!appState.selectedNodeId) return;
  const node = appState.nodes.get(appState.selectedNodeId);
  if (!node) {
    panelController.clearNode();
    appState.selectedNodeId = null;
    return;
  }
  panelController.setNode(node);
}

function runLayout(animate) {
  if (!appState.cy || appState.cy.nodes().length === 0) return;
  appState.cy.layout({
    name: 'cose',
    fit: true,
    animate: Boolean(animate),
    padding: 34,
    randomize: !appState.hasLaidOutGraph,
  }).run();
}

function normalizeNode(rawNode) {
  if (!rawNode || typeof rawNode !== 'object') return null;
  const id = String(rawNode.id || rawNode.nodeId || '');
  if (!id) return null;

  const existing = appState.nodes.get(id) || {};
  const grade = String(rawNode.grade || existing.grade || 'pending');
  const safeGrade = ['green', 'yellow', 'red', 'pending'].includes(grade) ? grade : 'pending';
  const score = Number.isFinite(rawNode.score) ? Number(rawNode.score)
    : (Number.isFinite(existing.score) ? existing.score : null);
  const healStatus = String(rawNode.healStatus || appState.healStatuses.get(id) || existing.healStatus || '');

  const node = {
    ...existing,
    ...rawNode,
    id,
    grade: safeGrade,
    score,
    healStatus,
  };

  if (!node.label || typeof node.label !== 'string') {
    node.label = inferNodeLabel(id);
  }

  return node;
}

function normalizeEdge(rawEdge) {
  if (!rawEdge || typeof rawEdge !== 'object') return null;
  const source = String(rawEdge.source || rawEdge.from || '');
  const target = String(rawEdge.target || rawEdge.to || '');
  if (!source || !target) return null;
  const edgeId = String(rawEdge.id || `${source}->${target}`);

  const existing = appState.edges.get(edgeId) || {};
  return {
    ...existing,
    ...rawEdge,
    id: edgeId,
    source,
    target,
  };
}

function looksLikeEdge(obj) {
  return Boolean(obj && typeof obj === 'object' && (obj.source || obj.from) && (obj.target || obj.to));
}

function looksLikeNode(obj) {
  return Boolean(obj && typeof obj === 'object' && (obj.id || obj.nodeId));
}

function inferNodeLabel(id) {
  const parts = String(id).split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] || id;
  return last.length > 26 ? `${last.slice(0, 23)}...` : last;
}

function setDriftScoreBadge(score) {
  if (!dom.driftScoreBadge) return;
  const clamped = clampScore(Number(score));
  dom.driftScoreBadge.textContent = `Drift ${Math.round(clamped)}`;
  if (clamped >= 70) dom.driftScoreBadge.dataset.grade = 'high';
  else if (clamped >= 40) dom.driftScoreBadge.dataset.grade = 'mid';
  else dom.driftScoreBadge.dataset.grade = 'low';
}

function setGenerationDone() {
  const now = new Date();
  setGenerationStatus(`Generation done (${now.toLocaleTimeString()})`);
}

function setGenerationStatus(text) {
  if (!dom.generationStatus) return;
  dom.generationStatus.textContent = text;
}

function setConnectionStatus(status) {
  if (!dom.connectionStatus) return;
  dom.connectionStatus.textContent = status;
  dom.connectionStatus.className = `connection-pill ${status}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderFallbackGraph() {
  if (!dom.graphContainer || appState.cy) return;

  const nodes = Array.from(appState.nodes.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const edges = Array.from(appState.edges.values());
  const nodeCards = nodes.length === 0
    ? '<div class="fallback-empty">No nodes yet. Add files in the tracked folder to see them appear.</div>'
    : nodes
      .map((node) => {
        const grade = ['green', 'yellow', 'red', 'pending'].includes(String(node.grade)) ? String(node.grade) : 'pending';
        const selected = appState.selectedNodeId === node.id ? ' selected' : '';
        const score = Number.isFinite(Number(node.score)) ? Number(node.score).toFixed(3) : '--';
        return (
          `<button class="fallback-node grade-${grade}${selected}" data-node-id="${escapeHtml(node.id)}">` +
          `<span class="fallback-node-path">${escapeHtml(node.id)}</span>` +
          `<span class="fallback-node-meta">grade: ${grade} · score: ${score}</span>` +
          '</button>'
        );
      })
      .join('');

  dom.graphContainer.innerHTML =
    `<div class="fallback-wrap">` +
    `<div class="fallback-summary">${nodes.length} nodes · ${edges.length} edges</div>` +
    `<div class="fallback-grid">${nodeCards}</div>` +
    `</div>`;

  const buttons = dom.graphContainer.querySelectorAll('[data-node-id]');
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const nodeId = button.getAttribute('data-node-id');
      if (!nodeId) return;
      appState.selectedNodeId = nodeId;
      const node = appState.nodes.get(nodeId) || null;
      panelController.setNode(node);
      renderFallbackGraph();
    });
  });
}

function renderNodeFeed() {
  if (!dom.nodeFeedCount || !dom.nodeFeedList) return;
  const nodes = Array.from(appState.nodes.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  dom.nodeFeedCount.textContent = String(nodes.length);
  dom.nodeFeedList.replaceChildren();

  if (nodes.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'node-feed-item grade-pending';
    empty.textContent = 'No nodes yet';
    dom.nodeFeedList.appendChild(empty);
    return;
  }

  nodes.slice(0, 200).forEach((node) => {
    const grade = ['green', 'yellow', 'red', 'pending'].includes(String(node.grade)) ? String(node.grade) : 'pending';
    const item = document.createElement('li');
    item.className = `node-feed-item grade-${grade}`;
    item.textContent = `${node.id}  [${grade}]`;
    dom.nodeFeedList.appendChild(item);
  });
}
