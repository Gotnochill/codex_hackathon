const DEFAULT_ARCH_HEALTH = {
  redNodeRatio: 0,
  depComplexity: 0,
  maxCyclomatic: 0,
  collapseScore: 0,
  warnings: [],
  destabilizing: false,
  lastUpdated: null,
};

function formatNodeScore(score) {
  if (!Number.isFinite(score)) return '--';
  if (score >= 0 && score <= 1) return score.toFixed(3);
  if (score >= 0 && score <= 100) return score.toFixed(1);
  return String(score);
}

function formatRatioAsPercent(value) {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(value * 100)}%`;
}

function coerceWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .filter((warning) => warning && typeof warning === 'object')
    .map((warning) => ({
      code: String(warning.code || 'UNKNOWN'),
      message: String(warning.message || ''),
    }));
}

function normalizeArchHealth(health) {
  const next = {
    ...DEFAULT_ARCH_HEALTH,
    ...(health && typeof health === 'object' ? health : {}),
  };
  next.redNodeRatio = Number.isFinite(next.redNodeRatio) ? next.redNodeRatio : 0;
  next.depComplexity = Number.isFinite(next.depComplexity) ? next.depComplexity : 0;
  next.maxCyclomatic = Number.isFinite(next.maxCyclomatic) ? next.maxCyclomatic : 0;
  next.collapseScore = Number.isFinite(next.collapseScore) ? next.collapseScore : 0;
  next.warnings = coerceWarnings(next.warnings);
  next.destabilizing = Boolean(next.destabilizing);
  next.lastUpdated = next.lastUpdated || null;
  return next;
}

function metricRow(label, value, threshold, pass) {
  return { label, value, threshold, pass };
}

export class PanelController {
  constructor({
    onManualHeal,
    onHealAll,
    onReanchor,
    onNodePanelClosed,
    getAllNodes,
  } = {}) {
    this.onManualHeal = onManualHeal;
    this.onHealAll = onHealAll;
    this.onReanchor = onReanchor;
    this.onNodePanelClosed = onNodePanelClosed;
    this.getAllNodes = getAllNodes;
    this.currentNode = null;
    this.currentArchHealth = DEFAULT_ARCH_HEALTH;
    this.currentRedNodeIds = [];

    this.nodePanel = document.getElementById('node-panel');
    this.nodePath = document.getElementById('node-path');
    this.nodeGradeBadge = document.getElementById('node-grade-badge');
    this.nodeScore = document.getElementById('node-score');
    this.nodeType = document.getElementById('node-type');
    this.nodeHealStatus = document.getElementById('node-heal-status');
    this.nodePreview = document.getElementById('node-preview');
    this.closeNodeBtn = document.getElementById('close-node-panel');
    this.reanchorBtn = document.getElementById('reanchor-btn');
    this.selfHealBtn = document.getElementById('self-heal-btn');

    this.archDrawer = document.getElementById('architecture-drawer');
    this.closeArchBtn = document.getElementById('close-architecture-drawer');
    this.archMetricsBody = document.getElementById('architecture-metrics-body');
    this.archWarningList = document.getElementById('architecture-warning-list');
    this.healAllBtn = document.getElementById('heal-all-red-btn');

    this.bindEvents();
    this.setArchitectureHealth(DEFAULT_ARCH_HEALTH);
    this.renderNode(null);
  }

  bindEvents() {
    if (this.closeNodeBtn) {
      this.closeNodeBtn.addEventListener('click', () => this.closeNodePanel(true));
    }

    if (this.closeArchBtn) {
      this.closeArchBtn.addEventListener('click', () => this.closeArchitectureDrawer());
    }

    if (this.selfHealBtn) {
      this.selfHealBtn.addEventListener('click', () => {
        if (!this.currentNode || typeof this.onManualHeal !== 'function') return;
        this.onManualHeal(this.currentNode.id);
      });
    }

    if (this.reanchorBtn) {
      this.reanchorBtn.disabled = typeof this.onReanchor !== 'function';
      this.reanchorBtn.addEventListener('click', () => {
        if (!this.currentNode || typeof this.onReanchor !== 'function') return;
        this.onReanchor(this.currentNode.id);
      });
    }

    if (this.healAllBtn) {
      this.healAllBtn.addEventListener('click', () => {
        if (typeof this.onHealAll !== 'function' || this.currentRedNodeIds.length === 0) return;
        this.onHealAll([...this.currentRedNodeIds]);
      });
    }
  }

  setNode(node) {
    this.currentNode = node || null;
    this.renderNode(this.currentNode);
    if (this.currentNode) {
      this.closeArchitectureDrawer(false);
      this.openNodePanel();
    }
  }

  clearNode() {
    this.currentNode = null;
    this.renderNode(null);
    this.closeNodePanel(false);
  }

  refresh() {
    this.updateHealAllButtonState();
    if (!this.currentNode) return;
    const refreshedNode = this.collectAllNodes().find((node) => node.id === this.currentNode.id);
    if (refreshedNode) {
      this.currentNode = refreshedNode;
      this.renderNode(refreshedNode);
    } else {
      this.clearNode();
    }
  }

  openNodePanel() {
    if (!this.nodePanel) return;
    this.nodePanel.classList.add('open');
    this.nodePanel.setAttribute('aria-hidden', 'false');
  }

  closeNodePanel(notify = false) {
    if (!this.nodePanel) return;
    this.nodePanel.classList.remove('open');
    this.nodePanel.setAttribute('aria-hidden', 'true');
    if (notify && typeof this.onNodePanelClosed === 'function') {
      this.onNodePanelClosed();
    }
  }

  openArchitectureDrawer() {
    if (!this.archDrawer) return;
    this.closeNodePanel(false);
    this.archDrawer.classList.add('open');
    this.archDrawer.setAttribute('aria-hidden', 'false');
    this.updateHealAllButtonState();
  }

  closeArchitectureDrawer(notify = true) {
    if (!this.archDrawer) return;
    this.archDrawer.classList.remove('open');
    this.archDrawer.setAttribute('aria-hidden', 'true');
    if (notify) this.updateHealAllButtonState();
  }

  setArchitectureHealth(health) {
    this.currentArchHealth = normalizeArchHealth(health);
    this.renderArchitectureMetrics();
    this.renderArchitectureWarnings();
    this.updateHealAllButtonState();
  }

  renderNode(node) {
    if (!node) {
      if (this.nodePath) this.nodePath.textContent = 'No node selected';
      if (this.nodeGradeBadge) {
        this.nodeGradeBadge.className = 'grade-badge pending';
        this.nodeGradeBadge.textContent = 'pending';
      }
      if (this.nodeScore) this.nodeScore.textContent = '--';
      if (this.nodeType) this.nodeType.textContent = '--';
      if (this.nodeHealStatus) this.nodeHealStatus.textContent = '--';
      if (this.nodePreview) this.nodePreview.textContent = 'Select a node in the graph to inspect details.';
      if (this.selfHealBtn) this.selfHealBtn.classList.add('is-hidden');
      return;
    }

    const grade = String(node.grade || 'pending');
    const safeGrade = ['green', 'yellow', 'red', 'pending'].includes(grade) ? grade : 'pending';
    const preview = String(node.code || node.preview || node.summary || '').trim();

    if (this.nodePath) this.nodePath.textContent = String(node.id || '');
    if (this.nodeGradeBadge) {
      this.nodeGradeBadge.className = `grade-badge ${safeGrade}`;
      this.nodeGradeBadge.textContent = safeGrade;
    }
    if (this.nodeScore) this.nodeScore.textContent = formatNodeScore(Number(node.score));
    if (this.nodeType) this.nodeType.textContent = String(node.type || '--');
    if (this.nodeHealStatus) this.nodeHealStatus.textContent = String(node.healStatus || '--');
    if (this.nodePreview) {
      this.nodePreview.textContent = preview.length > 500 ? `${preview.slice(0, 500)}...` : (preview || 'No preview available.');
    }

    if (this.selfHealBtn) {
      const isRed = safeGrade === 'red';
      this.selfHealBtn.classList.toggle('is-hidden', !isRed);
      this.selfHealBtn.disabled = typeof this.onManualHeal !== 'function';
    }
  }

  renderArchitectureMetrics() {
    if (!this.archMetricsBody) return;
    const h = this.currentArchHealth;
    const rows = [
      metricRow('Red Node Ratio', formatRatioAsPercent(h.redNodeRatio), '<= 35%', h.redNodeRatio <= 0.35),
      metricRow('Dependency Complexity', h.depComplexity.toFixed(2), '<= 3.5', h.depComplexity <= 3.5),
      metricRow('Max Cyclomatic', String(h.maxCyclomatic), '<= 15', h.maxCyclomatic <= 15),
      metricRow('Collapse Score', String(h.collapseScore), '<= 70', h.collapseScore <= 70),
    ];

    this.archMetricsBody.replaceChildren();
    rows.forEach((row) => {
      const tr = document.createElement('tr');

      const metricCell = document.createElement('td');
      metricCell.textContent = row.label;

      const valueCell = document.createElement('td');
      valueCell.textContent = row.value;

      const thresholdCell = document.createElement('td');
      thresholdCell.textContent = row.threshold;

      const statusCell = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `metric-badge ${row.pass ? 'pass' : 'fail'}`;
      badge.textContent = row.pass ? '✓' : '✗';
      statusCell.appendChild(badge);

      tr.append(metricCell, valueCell, thresholdCell, statusCell);
      this.archMetricsBody.appendChild(tr);
    });
  }

  renderArchitectureWarnings() {
    if (!this.archWarningList) return;
    const warnings = this.currentArchHealth.warnings;
    this.archWarningList.replaceChildren();

    if (warnings.length === 0) {
      const item = document.createElement('li');
      item.className = 'warning-item no-warnings';
      item.textContent = 'No active warnings.';
      this.archWarningList.appendChild(item);
      return;
    }

    warnings.forEach((warning) => {
      const item = document.createElement('li');
      item.className = 'warning-item';

      const code = document.createElement('code');
      code.className = 'warning-code';
      code.textContent = warning.code;

      const message = document.createElement('span');
      message.textContent = warning.message;

      item.append(code, message);
      this.archWarningList.appendChild(item);
    });
  }

  updateHealAllButtonState() {
    this.currentRedNodeIds = this.collectAllNodes()
      .filter((node) => String(node.grade || '') === 'red')
      .map((node) => String(node.id));

    if (!this.healAllBtn) return;
    const count = this.currentRedNodeIds.length;
    this.healAllBtn.textContent = count > 0
      ? `Heal All Red Nodes (${count})`
      : 'Heal All Red Nodes';
    this.healAllBtn.disabled = count === 0 || typeof this.onHealAll !== 'function';
  }

  collectAllNodes() {
    if (typeof this.getAllNodes !== 'function') return [];
    const nodes = this.getAllNodes();
    return Array.isArray(nodes) ? nodes : [];
  }
}
