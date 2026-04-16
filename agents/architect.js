const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const { computeCyclomatic } = require('../scripts/cyclomatic');

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'shared', 'map-state.json');
const ARCH_PATH = path.join(ROOT, 'shared', 'arch-health.json');
const DEBOUNCE_MS = 1000;
const MAX_CODE_SIZE = 100000;

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

function computeRedNodeRatio(nodes) {
  const scored = nodes.filter((node) => node.grade !== 'pending');
  if (scored.length === 0) return 0;
  const red = scored.filter((node) => node.grade === 'red').length;
  return red / scored.length;
}

function computeDepComplexity(nodes, edges) {
  if (nodes.length === 0) return 0;
  return edges.length / nodes.length;
}

function computeMaxCyclomatic(nodes) {
  let max = 0;
  for (const node of nodes) {
    if (node.type !== 'function' || typeof node.code !== 'string') continue;
    if (node.code.length > MAX_CODE_SIZE) continue;
    const score = computeCyclomatic(node.code);
    if (score > max) max = score;
  }
  return max;
}

function computeCollapseScore(redRatio, depComplexity, maxCyclo) {
  const redComponent = Math.min(redRatio / 0.35, 1) * 40;
  const depComponent = Math.min(depComplexity / 3.5, 1) * 30;
  const cycloComponent = Math.min(maxCyclo / 15, 1) * 30;
  return Math.round(redComponent + depComponent + cycloComponent);
}

function buildWarnings(metrics) {
  const warnings = [];

  if (metrics.redNodeRatio > 0.35) {
    warnings.push({
      code: 'RED_NODE_DENSITY',
      message: `${Math.round(metrics.redNodeRatio * 100)}% of nodes are out of spec.`,
    });
  }

  if (metrics.depComplexity > 3.5) {
    warnings.push({
      code: 'DEP_COMPLEXITY',
      message: `Dependency graph complexity is ${metrics.depComplexity.toFixed(1)} (threshold: 3.5).`,
    });
  }

  if (metrics.maxCyclomatic > 15) {
    warnings.push({
      code: 'CYCLOMATIC',
      message: `A function has cyclomatic complexity ${metrics.maxCyclomatic} (threshold: 15).`,
    });
  }

  return warnings;
}

function recompute() {
  try {
    const state = safeReadJson(STATE_PATH, { nodes: [], edges: [] });
    const nodes = Array.isArray(state.nodes) ? state.nodes : [];
    const edges = Array.isArray(state.edges) ? state.edges : [];

    const scoredNodes = nodes.filter((node) => node.grade !== 'pending');
    const scoredCount = scoredNodes.length;

    const redNodeRatio = computeRedNodeRatio(nodes);
    const depComplexity = computeDepComplexity(nodes, edges);
    const maxCyclomatic = computeMaxCyclomatic(nodes);

    let collapseScore = 0;
    let warnings = [];
    let destabilizing = false;

    if (scoredCount >= 5) {
      collapseScore = computeCollapseScore(redNodeRatio, depComplexity, maxCyclomatic);
      warnings = buildWarnings({ redNodeRatio, depComplexity, maxCyclomatic });
      destabilizing = collapseScore > 70;
    }

    const health = {
      redNodeRatio: parseFloat(redNodeRatio.toFixed(3)),
      depComplexity: parseFloat(depComplexity.toFixed(3)),
      maxCyclomatic,
      collapseScore,
      warnings,
      destabilizing,
      lastUpdated: new Date().toISOString(),
    };

    atomicWriteJson(ARCH_PATH, health);
  } catch (error) {
    console.error('[architect] error:', error.message);
  }
}

let debounceTimer = null;
function scheduleRecompute() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    recompute();
  }, DEBOUNCE_MS);
}

if (!fs.existsSync(path.dirname(ARCH_PATH))) {
  fs.mkdirSync(path.dirname(ARCH_PATH), { recursive: true });
}

if (!fs.existsSync(ARCH_PATH)) {
  atomicWriteJson(ARCH_PATH, {
    redNodeRatio: 0,
    depComplexity: 0,
    maxCyclomatic: 0,
    collapseScore: 0,
    warnings: [],
    destabilizing: false,
    lastUpdated: null,
  });
}

chokidar
  .watch(STATE_PATH, {
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 40,
    },
  })
  .on('add', scheduleRecompute)
  .on('change', scheduleRecompute)
  .on('error', (error) => {
    console.error('[architect] watcher error:', error.message);
  });
