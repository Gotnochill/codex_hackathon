import { DriftChart, clampScore } from './drift-chart.js';
import { PanelController } from './panel.js';

const SERVER_MESSAGE_TYPES = new Set([
  'graph_update',
  'node_grade',
  'full_reset',
  'generation_status',
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
const MAX_VISIBLE_GRAPH_NODES = 220;

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
  trackedPath: '',
  folderBrowserCurrentPath: '',
  folderBrowserParentPath: null,
  folderBrowserSelectedPath: '',
  folderBrowserBusy: false,
  expandedFolderIds: new Set(),
  virtualNodeIds: new Set(), // tracks synthesised folder node IDs
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
  trackingForm: document.getElementById('tracking-form'),
  trackingPathInput: document.getElementById('tracking-path-input'),
  trackingPathBrowse: document.getElementById('tracking-path-browse'),
  trackingPathSave: document.getElementById('tracking-path-save'),
  trackingFooterForm: document.getElementById('tracking-form-footer'),
  trackingFooterInput: document.getElementById('tracking-path-input-footer'),
  trackingFooterSave: document.getElementById('tracking-path-save-footer'),
  trackingPathCurrent: document.getElementById('tracking-path-current'),
  analyzeButton: document.getElementById('analyze-btn'),
  resetAllButton: document.getElementById('reset-all-btn'),
  folderBrowserModal: document.getElementById('folder-browser-modal'),
  folderBrowserClose: document.getElementById('folder-browser-close'),
  folderBrowserUp: document.getElementById('folder-browser-up'),
  folderBrowserCurrent: document.getElementById('folder-browser-current'),
  folderBrowserList: document.getElementById('folder-browser-list'),
  folderBrowserCancel: document.getElementById('folder-browser-cancel'),
  folderBrowserSelect: document.getElementById('folder-browser-select'),
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

if (dom.analyzeButton) {
  dom.analyzeButton.disabled = true;
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

if (dom.trackingForm) {
  dom.trackingForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const nextPath = String(dom.trackingPathInput?.value || '').trim();
    if (!nextPath) return;
    updateTrackingPath(nextPath);
  });
}

if (dom.trackingPathBrowse) {
  dom.trackingPathBrowse.addEventListener('click', () => {
    openFolderBrowser();
  });
}

if (dom.trackingFooterForm) {
  dom.trackingFooterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const nextPath = String(dom.trackingFooterInput?.value || '').trim();
    if (!nextPath) return;
    updateTrackingPath(nextPath);
  });
}

if (dom.resetAllButton) {
  dom.resetAllButton.addEventListener('click', () => {
    resetAllState();
  });
}

if (dom.analyzeButton) {
  dom.analyzeButton.addEventListener('click', () => {
    triggerAnalyze();
  });
}

if (dom.folderBrowserClose) {
  dom.folderBrowserClose.addEventListener('click', () => {
    closeFolderBrowser();
  });
}

if (dom.folderBrowserCancel) {
  dom.folderBrowserCancel.addEventListener('click', () => {
    closeFolderBrowser();
  });
}

if (dom.folderBrowserUp) {
  dom.folderBrowserUp.addEventListener('click', () => {
    if (!appState.folderBrowserParentPath || appState.folderBrowserBusy) return;
    loadFolderBrowserRoot(appState.folderBrowserParentPath);
  });
}

if (dom.folderBrowserSelect) {
  dom.folderBrowserSelect.addEventListener('click', async () => {
    const selectedPath = String(appState.folderBrowserSelectedPath || '').trim();
    if (!selectedPath || appState.folderBrowserBusy) return;
    closeFolderBrowser();
    await updateTrackingPath(selectedPath);
  });
}

if (dom.folderBrowserModal) {
  dom.folderBrowserModal.addEventListener('click', (event) => {
    if (event.target === dom.folderBrowserModal) {
      closeFolderBrowser();
    }
  });
}

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!dom.folderBrowserModal || dom.folderBrowserModal.classList.contains('is-hidden')) return;
  closeFolderBrowser();
});

appState.cy = initGraph();
setConnectionStatus('disconnected');
updateArchHealthUI(ARCH_DEFAULT);
connectWebSocket();
startHttpSyncLoop();
loadTrackingPath();

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
    layout: { name: 'breadthfirst', directed: true, fit: true, padding: 44 },
    style: [
      // Base file node
      {
        selector: 'node',
        css: {
          label: 'data(label)',
          'text-wrap': 'ellipsis',
          'text-max-width': 180,
          'font-size': 16,
          'font-weight': '600',
          'font-family': '"Inter", "Plus Jakarta Sans", "Segoe UI", sans-serif',
          color: '#ffffff',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 10,
          'text-background-color': '#020617',
          'text-background-opacity': 0.85,
          'text-background-padding': '6px',
          'text-background-shape': 'roundrectangle',
          'text-outline-width': 0,
          'background-color': '#334155',
          'border-width': 3,
          'border-color': '#64748b',
          width: 72,
          height: 72,
          'transition-property': 'background-color, border-color, border-width, width, height',
          'transition-duration': '300ms',
        },
      },
      // Virtual folder node
      {
        selector: 'node[type = "folder"]',
        css: {
          shape: 'roundrectangle',
          width: 180,
          height: 56,
          'background-color': '#1e1b4b',
          'border-color': '#6366f1',
          'border-width': 3,
          'font-size': 16,
          'font-weight': '700',
          'text-max-width': 160,
          'text-outline-width': 0,
          color: '#c7d2fe',
        },
      },
      // Grade colors
      { selector: 'node[grade = "green"]',   css: { 'background-color': '#15803d', 'border-color': '#4ade80', 'border-width': 2 } },
      { selector: 'node[grade = "yellow"]',  css: { 'background-color': '#92400e', 'border-color': '#fcd34d', 'border-width': 2 } },
      { selector: 'node[grade = "red"]',     css: { 'background-color': '#991b1b', 'border-color': '#fca5a5', 'border-width': 2 } },
      { selector: 'node[grade = "pending"]', css: { 'background-color': '#334155', 'border-color': '#64748b' } },
      // Selection ring
      {
        selector: 'node:selected',
        css: { 'border-color': '#38bdf8', 'border-width': 4 },
      },
      // Real import edges
      {
        selector: 'edge',
        css: {
          width: 2,
          'line-color': '#818cf8',
          'target-arrow-color': '#818cf8',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          opacity: 0.75,
        },
      },
      // Virtual hierarchy edges (folder -> child)
      {
        selector: 'edge[?virtual]',
        css: {
          width: 1.5,
          'line-color': '#4f46e5',
          'target-arrow-color': '#4f46e5',
          'target-arrow-shape': 'vee',
          'curve-style': 'taxi',
          'taxi-direction': 'downward',
          opacity: 0.5,
        },
      },
      // Heal-status rings
      { selector: 'node[healStatus = "healing"]', css: { 'border-color': '#a78bfa', 'border-width': 4, 'border-style': 'dashed' } },
      { selector: 'node[healStatus = "done"]',    css: { 'border-color': '#4ade80', 'border-width': 2 } },
      { selector: 'node[healStatus = "failed"]',  css: { 'border-color': '#f87171', 'border-width': 2, 'border-style': 'dotted' } },
      { selector: '.graph-hidden', css: { display: 'none' } },
    ],
  });

  cy.on('tap', 'node', (event) => {
    const nodeId = event.target.id();
    if (String(nodeId).startsWith('__dir__')) {
      toggleFolderExpansion(nodeId);
      return;
    }
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
    if (!dom.generationStatus?.textContent?.trim()) {
      setGenerationStatus('Connected');
    }
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

async function loadTrackingPath() {
  try {
    const res = await fetch('/api/tracking', { cache: 'no-store' });
    if (!res.ok) return;
    const payload = await res.json();
    updateTrackingPathUi(payload.trackedPath || '');
  } catch (_) {
    // no-op
  }
}

function openFolderBrowser() {
  if (!dom.folderBrowserModal) return;
  dom.folderBrowserModal.classList.remove('is-hidden');
  const startPath = appState.trackedPath || '';
  loadFolderBrowserRoot(startPath);
}

function closeFolderBrowser() {
  if (!dom.folderBrowserModal) return;
  dom.folderBrowserModal.classList.add('is-hidden');
}

function setFolderBrowserBusy(isBusy) {
  appState.folderBrowserBusy = Boolean(isBusy);
  if (dom.folderBrowserUp) {
    dom.folderBrowserUp.disabled = isBusy || !appState.folderBrowserParentPath;
  }
  if (dom.folderBrowserSelect) {
    dom.folderBrowserSelect.disabled = isBusy || !String(appState.folderBrowserSelectedPath || '').trim();
    dom.folderBrowserSelect.textContent = isBusy ? 'Loading...' : 'Select This Folder';
  }
}

function setFolderBrowserSelectedPath(nextPath) {
  const value = String(nextPath || '').trim();
  appState.folderBrowserSelectedPath = value;

  if (dom.folderBrowserCurrent) {
    dom.folderBrowserCurrent.textContent = value || '--';
    dom.folderBrowserCurrent.title = value || '';
  }

  if (!dom.folderBrowserList) return;
  const rows = dom.folderBrowserList.querySelectorAll('.folder-browser-entry');
  rows.forEach((row) => {
    const rowPath = String(row.getAttribute('data-path') || '');
    if (rowPath === value) {
      row.classList.add('is-selected');
    } else {
      row.classList.remove('is-selected');
    }
  });

  setFolderBrowserBusy(appState.folderBrowserBusy);
}

async function fetchFolderListing(requestPath = '') {
  const query = String(requestPath || '').trim();
  const url = query
    ? `/api/folders?path=${encodeURIComponent(query)}`
    : '/api/folders';

  try {
    const res = await fetch(url, { cache: 'no-store' });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) {
      setGenerationStatus(payload.error || 'Unable to browse folders');
      return null;
    }

    return payload;
  } catch (_) {
    setGenerationStatus('Unable to browse folders');
    return null;
  }
}

function createFolderBrowserEntry(dir) {
  const name = String(dir?.name || '').trim();
  const pathValue = String(dir?.path || '').trim();
  if (!name || !pathValue) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'folder-browser-tree-item';
  wrapper.setAttribute('data-tree-path', pathValue);

  const row = document.createElement('div');
  row.className = 'folder-browser-entry';
  row.setAttribute('data-path', pathValue);
  row.setAttribute('role', 'button');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'folder-entry-toggle';
  toggle.textContent = '▸';
  toggle.setAttribute('aria-label', `Expand ${name}`);

  const label = document.createElement('span');
  label.className = 'folder-entry-label';
  label.textContent = `${name}/`;
  label.title = pathValue;

  row.append(toggle, label);
  wrapper.appendChild(row);

  const children = document.createElement('div');
  children.className = 'folder-browser-children is-hidden';
  wrapper.appendChild(children);

  row.addEventListener('click', (event) => {
    if (event.target === toggle) return;
    setFolderBrowserSelectedPath(pathValue);
  });

  toggle.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (appState.folderBrowserBusy) return;

    const isOpen = wrapper.classList.contains('is-open');
    if (isOpen) {
      wrapper.classList.remove('is-open');
      children.classList.add('is-hidden');
      toggle.textContent = '▸';
      return;
    }

    wrapper.classList.add('is-open');
    children.classList.remove('is-hidden');
    toggle.textContent = '▾';

    if (wrapper.getAttribute('data-loaded') === 'true') {
      return;
    }

    children.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'folder-browser-empty';
    loading.textContent = 'Loading...';
    children.appendChild(loading);

    const payload = await fetchFolderListing(pathValue);
    children.replaceChildren();
    if (!payload) {
      const empty = document.createElement('div');
      empty.className = 'folder-browser-empty';
      empty.textContent = 'Unable to load subfolders.';
      children.appendChild(empty);
      return;
    }

    const nested = Array.isArray(payload.directories) ? payload.directories : [];
    if (nested.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'folder-browser-empty';
      empty.textContent = 'No subfolders.';
      children.appendChild(empty);
    } else {
      nested.forEach((childDir) => {
        const childEntry = createFolderBrowserEntry(childDir);
        if (childEntry) children.appendChild(childEntry);
      });
    }

    wrapper.setAttribute('data-loaded', 'true');
    setFolderBrowserSelectedPath(appState.folderBrowserSelectedPath);
  });

  return wrapper;
}

async function loadFolderBrowserRoot(requestPath = '') {
  if (!dom.folderBrowserList) return;

  setFolderBrowserBusy(true);
  try {
    const payload = await fetchFolderListing(requestPath);
    if (!payload) return;

    appState.folderBrowserCurrentPath = String(payload.currentPath || '').trim();
    appState.folderBrowserParentPath =
      typeof payload.parentPath === 'string' && payload.parentPath.trim()
        ? payload.parentPath.trim()
        : null;

    dom.folderBrowserList.replaceChildren();
    const directories = Array.isArray(payload.directories) ? payload.directories : [];
    if (directories.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'folder-browser-empty';
      empty.textContent = 'No subfolders in this directory.';
      dom.folderBrowserList.appendChild(empty);
    } else {
      directories.forEach((dir) => {
        const entry = createFolderBrowserEntry(dir);
        if (entry) dom.folderBrowserList.appendChild(entry);
      });
    }

    setFolderBrowserSelectedPath(appState.folderBrowserCurrentPath);
  } finally {
    setFolderBrowserBusy(false);
  }
}

async function updateTrackingPath(nextPath) {
  if (!dom.trackingPathSave && !dom.trackingFooterSave) return;
  if (dom.trackingPathSave) {
    dom.trackingPathSave.disabled = true;
    dom.trackingPathSave.textContent = 'Applying...';
  }
  if (dom.trackingFooterSave) {
    dom.trackingFooterSave.disabled = true;
    dom.trackingFooterSave.textContent = 'Applying...';
  }
  if (dom.trackingPathBrowse) {
    dom.trackingPathBrowse.disabled = true;
  }

  try {
    const res = await fetch('/api/tracking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: nextPath }),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) {
      setGenerationStatus(payload.error || 'Unable to update tracking path');
      return;
    }

    updateTrackingPathUi(payload.trackedPath || nextPath);
    setGenerationStatus('Tracking path updated');
  } catch (_) {
    setGenerationStatus('Unable to update tracking path');
  } finally {
    if (dom.trackingPathSave) {
      dom.trackingPathSave.disabled = false;
      dom.trackingPathSave.textContent = 'Apply';
    }
    if (dom.trackingFooterSave) {
      dom.trackingFooterSave.disabled = false;
      dom.trackingFooterSave.textContent = 'Apply';
    }
    if (dom.trackingPathBrowse) {
      dom.trackingPathBrowse.disabled = false;
    }
  }
}

async function resetAllState() {
  if (!dom.resetAllButton) return;

  const confirmed = window.confirm('Reset all graph state, clear history, and stop tracking this folder?');
  if (!confirmed) return;

  dom.resetAllButton.disabled = true;
  dom.resetAllButton.textContent = 'Resetting...';

  try {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const payload = await res.json().catch(() => ({}));

    if (!res.ok || !payload.ok) {
      setGenerationStatus(payload.error || 'Unable to reset state');
      return;
    }

    if (payload.mapState && typeof payload.mapState === 'object') {
      applyFullReset({
        ...payload.mapState,
        trackedPath: '',
        autoHeal: false,
        generation: payload.generation || null,
      });
    } else {
      applyFullReset({
        nodes: [],
        edges: [],
        driftScore: null,
        lastUpdated: null,
        trackedPath: '',
        autoHeal: false,
        generation: payload.generation || null,
      });
    }

    applyDriftHistory(payload.driftHistory || { snapshots: [] });
    applyArchHealth(payload.archHealth || ARCH_DEFAULT);
    updateTrackingPathUi('');
    applyGenerationStatus(payload.generation || { running: false, done: false });
    setGenerationStatus('Reset complete');
  } catch (_) {
    setGenerationStatus('Unable to reset state');
  } finally {
    dom.resetAllButton.disabled = false;
    dom.resetAllButton.textContent = 'Reset';
  }
}

async function triggerAnalyze() {
  if (!dom.analyzeButton) return;
  if (!String(appState.trackedPath || '').trim()) {
    setGenerationStatus('Set a tracking path first');
    return;
  }

  dom.analyzeButton.disabled = true;
  dom.analyzeButton.textContent = 'Analyzing...';

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) {
      setGenerationStatus(payload.error || 'Unable to start analyze');
      return;
    }
    setGenerationStatus('Analyze requested');
  } catch (_) {
    setGenerationStatus('Unable to start analyze');
  } finally {
    dom.analyzeButton.disabled = !String(appState.trackedPath || '').trim();
    dom.analyzeButton.textContent = 'Analyze';
  }
}

function updateTrackingPathUi(nextPath) {
  const value = String(nextPath || '').trim();
  const previousPath = appState.trackedPath;
  appState.trackedPath = value;

  if (dom.trackingPathInput && dom.trackingPathInput.value !== value) {
    dom.trackingPathInput.value = value;
  }
  if (dom.trackingFooterInput && dom.trackingFooterInput.value !== value) {
    dom.trackingFooterInput.value = value;
  }
  if (dom.trackingPathCurrent) {
    dom.trackingPathCurrent.textContent = `Tracking: ${value || '--'}`;
  }
  if (dom.analyzeButton) {
    dom.analyzeButton.disabled = !value;
  }

  if (previousPath !== value) {
    if (appState.cy) {
      appState.virtualNodeIds.forEach((vid) => {
        const el = appState.cy.getElementById(vid);
        if (el.length) el.remove();
      });
      appState.cy.edges('[?virtual]').remove();

      const { virtualNodes, virtualEdges } = buildVirtualHierarchy(Array.from(appState.nodes.values()), appState.trackedPath);
      appState.virtualNodeIds = new Set(virtualNodes.map((node) => node.id));
      const virtualElements = [
        ...virtualNodes.map((node) => ({ group: 'nodes', data: node })),
        ...virtualEdges.map((edge) => ({ group: 'edges', data: edge })),
      ];
      if (virtualElements.length > 0) {
        try {
          appState.cy.add(virtualElements);
        } catch (_) {
          // no-op
        }
      }
      ensureExpandedRootFolders();
      applyFolderVisibilityLimit();
      runLayout(appState.hasLaidOutGraph);
      appState.hasLaidOutGraph = true;
    } else {
      renderFallbackGraph();
    }
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
    case 'generation_status':
      applyGenerationStatus(payload);
      break;
    case 'generation_done':
      setGenerationDone(payload);
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
  const trackedPath = typeof state.trackedPath === 'string' ? state.trackedPath : '';

  appState.trackedPath = trackedPath;

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

  // Synthesise virtual folder nodes + hierarchy edges so the graph always
  // shows a parent→child tree even when there are no real import edges.
  const { virtualNodes, virtualEdges } = buildVirtualHierarchy(Array.from(appState.nodes.values()), appState.trackedPath);
  appState.virtualNodeIds = new Set(virtualNodes.map((n) => n.id));
  virtualNodes.forEach((vn) => elements.push({ group: 'nodes', data: vn }));
  virtualEdges.forEach((ve) => elements.push({ group: 'edges', data: ve }));

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
    appState.expandedFolderIds.clear();
    ensureExpandedRootFolders();
    applyFolderVisibilityLimit();
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
  updateTrackingPathUi(trackedPath);
  applyGenerationStatus(state.generation);

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

  // Rebuild virtual folder hierarchy whenever the node set changes
  if (appState.cy && (addedElements > 0 || parsed.removedNodeIds.length > 0)) {
    // Remove stale virtual nodes first
    appState.virtualNodeIds.forEach((vid) => {
      const el = appState.cy.getElementById(vid);
      if (el.length) el.remove();
    });
    // Remove stale virtual edges
    appState.cy.edges('[?virtual]').remove();
    // Re-inject
    const { virtualNodes, virtualEdges } = buildVirtualHierarchy(Array.from(appState.nodes.values()), appState.trackedPath);
    appState.virtualNodeIds = new Set(virtualNodes.map((n) => n.id));
    const vEls = [
      ...virtualNodes.map((vn) => ({ group: 'nodes', data: vn })),
      ...virtualEdges.map((ve) => ({ group: 'edges', data: ve })),
    ];
    if (vEls.length > 0) {
      try { appState.cy.add(vEls); } catch (_) {}
    }
    ensureExpandedRootFolders();
    applyFolderVisibilityLimit();
    runLayout(appState.hasLaidOutGraph);
    appState.hasLaidOutGraph = true;
  }
  if (appState.cy) {
    ensureExpandedRootFolders();
    applyFolderVisibilityLimit();
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

function getRootFolderNodeIds() {
  if (!appState.cy) return [];
  return appState.cy
    .nodes('[type = "folder"]')
    .filter((node) => node.incomers('edge[?virtual]').length === 0)
    .map((node) => node.id());
}

function ensureExpandedRootFolders() {
  const roots = getRootFolderNodeIds();
  if (roots.length === 0) return;
  roots.forEach((id) => {
    appState.expandedFolderIds.add(id);
  });
}

function applyFolderVisibilityLimit() {
  if (!appState.cy) return;

  const visibleNodeIds = new Set();
  const visibleEdgeIds = new Set();
  const rootIds = getRootFolderNodeIds();
  let hitCap = false;

  const visitFolder = (folderId) => {
    if (!appState.cy || hitCap) return;
    if (visibleNodeIds.size >= MAX_VISIBLE_GRAPH_NODES) {
      hitCap = true;
      return;
    }

    visibleNodeIds.add(folderId);
    if (!appState.expandedFolderIds.has(folderId)) return;

    const folder = appState.cy.getElementById(folderId);
    if (!folder || folder.length === 0) return;

    const edges = folder.outgoers('edge[?virtual]');
    edges.forEach((edge) => {
      if (hitCap) return;
      const child = edge.target();
      if (!child || child.length === 0) return;

      if (!visibleNodeIds.has(child.id()) && visibleNodeIds.size >= MAX_VISIBLE_GRAPH_NODES) {
        hitCap = true;
        return;
      }

      visibleEdgeIds.add(edge.id());
      visibleNodeIds.add(child.id());
      if (child.data('type') === 'folder') {
        visitFolder(child.id());
      }
    });
  };

  if (rootIds.length > 0) {
    rootIds.forEach((rootId) => visitFolder(rootId));
  } else {
    // Fallback: no virtual hierarchy, keep all real file nodes visible.
    appState.cy.nodes().forEach((node) => {
      if (visibleNodeIds.size < MAX_VISIBLE_GRAPH_NODES) {
        visibleNodeIds.add(node.id());
      } else {
        hitCap = true;
      }
    });
  }

  // Show real edges only when both source/target nodes are visible.
  appState.cy.edges().forEach((edge) => {
    if (edge.data('virtual')) return;
    if (visibleNodeIds.has(edge.data('source')) && visibleNodeIds.has(edge.data('target'))) {
      visibleEdgeIds.add(edge.id());
    }
  });

  appState.cy.nodes().forEach((node) => {
    if (visibleNodeIds.has(node.id())) node.removeClass('graph-hidden');
    else node.addClass('graph-hidden');
  });
  appState.cy.edges().forEach((edge) => {
    if (visibleEdgeIds.has(edge.id())) edge.removeClass('graph-hidden');
    else edge.addClass('graph-hidden');
  });

  if (hitCap) {
    setGenerationStatus(`Showing first ${MAX_VISIBLE_GRAPH_NODES} nodes. Expand fewer folders for stability.`);
  }
}

function toggleFolderExpansion(folderNodeId) {
  if (!folderNodeId || !appState.cy) return;
  if (!appState.expandedFolderIds.has(folderNodeId)) {
    appState.expandedFolderIds.add(folderNodeId);
  } else {
    appState.expandedFolderIds.delete(folderNodeId);
    ensureExpandedRootFolders();
  }
  applyFolderVisibilityLimit();
  runLayout(true);
}

function runLayout(animate) {
  if (!appState.cy || appState.cy.nodes().length === 0) return;
  // Root nodes = those with no incoming edges (top of the tree)
  const roots = appState.cy.nodes().filter((n) => n.indegree() === 0);
  appState.cy.layout({
    name: 'breadthfirst',
    directed: true,
    fit: true,
    animate: Boolean(animate),
    animationDuration: 500,
    animationEasing: 'ease-out-expo',
    padding: 52,
    spacingFactor: 1.65,
    avoidOverlap: true,
    roots: roots.length > 0 ? roots : undefined,
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

function inferTrackedRootLabel(trackedPath) {
  const normalized = String(trackedPath || '').trim().replace(/[\\/]+$/, '');
  if (!normalized) return '';
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

/**
 * Synthesise folder nodes + directed edges from file paths so the graph
 * renders as a directory tree even when there are no real import edges.
 * Folder node IDs are prefixed with `__dir__` to distinguish them.
 */
function buildVirtualHierarchy(nodeList, trackedPath = '') {
  const virtualNodes = [];
  const virtualEdges = [];
  const folderSeen = new Set();
  const edgeSeen = new Set();
  const trackedRootLabel = inferTrackedRootLabel(trackedPath);
  const trackedRootId = '__dir__root';
  const hasTrackedRoot = Boolean(trackedRootLabel);

  if (hasTrackedRoot) {
    folderSeen.add(trackedRootId);
    virtualNodes.push({
      id: trackedRootId,
      label: trackedRootLabel,
      type: 'folder',
      grade: 'folder',
    });
  }

  for (const node of nodeList) {
    const rawId = String(node.id || '');
    // Skip virtual nodes themselves
    if (rawId.startsWith('__dir__')) continue;

    const parts = rawId.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    // Walk every directory depth, creating folder nodes as needed
    for (let depth = 1; depth < parts.length; depth++) {
      const folderPath = parts.slice(0, depth).join('/');
      const folderId   = `__dir__${folderPath}`;

      if (!folderSeen.has(folderId)) {
        folderSeen.add(folderId);
        virtualNodes.push({
          id:    folderId,
          label: parts[depth - 1],   // just the directory name
          type:  'folder',
          grade: 'folder',
        });

        // Connect this folder to its parent folder (or tracked root).
        if (depth > 1 || hasTrackedRoot) {
          const parentId =
            depth === 1
              ? trackedRootId
              : `__dir__${parts.slice(0, depth - 1).join('/')}`;
          const eid        = `${parentId}->${folderId}`;
          if (!edgeSeen.has(eid)) {
            edgeSeen.add(eid);
            virtualEdges.push({ id: eid, source: parentId, target: folderId, virtual: true });
          }
        }
      }
    }

    // Connect the file node to its immediate parent folder
    const parentId =
      parts.length > 1
        ? `__dir__${parts.slice(0, -1).join('/')}`
        : (hasTrackedRoot ? trackedRootId : null);
    if (!parentId) continue;
    const eid        = `${parentId}->${rawId}`;
    if (!edgeSeen.has(eid)) {
      edgeSeen.add(eid);
      virtualEdges.push({ id: eid, source: parentId, target: rawId, virtual: true });
    }
  }

  return { virtualNodes, virtualEdges };
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

function applyGenerationStatus(payload) {
  const status = (payload && typeof payload === 'object') ? payload : {};
  const running = Boolean(status.running);
  const done = Boolean(status.done);
  const finishedAt = status.finishedAt ? new Date(status.finishedAt) : null;

  if (running) {
    setGenerationStatus('Generation running');
    return;
  }

  if (done && finishedAt && !Number.isNaN(finishedAt.getTime())) {
    setGenerationStatus(`Generation done (${finishedAt.toLocaleTimeString()})`);
    return;
  }

  if (done) {
    setGenerationStatus('Generation done');
    return;
  }

  setGenerationStatus('Idle');
}

function setGenerationDone(payload) {
  const finishedAt = payload && payload.finishedAt ? new Date(payload.finishedAt) : new Date();
  const now = Number.isNaN(finishedAt.getTime()) ? new Date() : finishedAt;
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
  let nodes = Array.from(appState.nodes.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (appState.cy) {
    const visibleIds = new Set(appState.cy.nodes(':visible').map((node) => node.id()));
    nodes = nodes.filter((node) => visibleIds.has(node.id));
  }
  const limited = nodes.slice(0, MAX_VISIBLE_GRAPH_NODES);
  dom.nodeFeedCount.textContent = nodes.length > limited.length
    ? `${limited.length}/${nodes.length}`
    : String(limited.length);
  dom.nodeFeedList.replaceChildren();

  if (limited.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'node-feed-item grade-pending';
    empty.textContent = 'No nodes yet';
    dom.nodeFeedList.appendChild(empty);
    return;
  }

  limited.forEach((node) => {
    const grade = ['green', 'yellow', 'red', 'pending'].includes(String(node.grade)) ? String(node.grade) : 'pending';
    const item = document.createElement('li');
    item.className = `node-feed-item grade-${grade}`;
    item.textContent = `${node.id}  [${grade}]`;
    dom.nodeFeedList.appendChild(item);
  });
}
