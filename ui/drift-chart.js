const TREND_COLORS = {
  improving: '#22c55e',
  stable: '#94a3b8',
  worsening: '#ef4444',
};

const MAX_SPARKLINE_POINTS = 30;
const WARNING_SUPPRESS_MS = 60_000;

export function clampScore(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function computeTrend(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return 'stable';
  const windowSlice = snapshots.slice(-5);
  const first = clampScore(Number(windowSlice[0]?.driftScore));
  const last = clampScore(Number(windowSlice[windowSlice.length - 1]?.driftScore));
  const delta = last - first;
  if (delta <= -10) return 'worsening';
  if (delta >= 5) return 'improving';
  return 'stable';
}

function parseTimestamp(snapshot, fallbackIndex) {
  const parsed = Date.parse(snapshot?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : fallbackIndex;
}

function normalizeSnapshots(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((snapshot, index) => ({
      timestamp: parseTimestamp(snapshot, index),
      score: clampScore(Number(snapshot?.driftScore)),
      trigger: snapshot?.trigger || null,
    }))
    .filter((snapshot) => Number.isFinite(snapshot.timestamp));
}

export class DriftChart {
  constructor({ svgEl, trendLabelEl, bannerEl, dismissButtonEl }) {
    this.svgEl = svgEl;
    this.trendLabelEl = trendLabelEl;
    this.bannerEl = bannerEl;
    this.dismissButtonEl = dismissButtonEl;
    this.dismissedUntil = 0;
    this.currentTrend = 'stable';
    this.warningTimer = null;

    if (this.dismissButtonEl) {
      this.dismissButtonEl.addEventListener('click', () => this.dismissWarning());
    }
  }

  setSnapshots(snapshots) {
    const normalized = normalizeSnapshots(snapshots).slice(-MAX_SPARKLINE_POINTS);
    this.currentTrend = computeTrend(normalized);
    this.renderSparkline(normalized, this.currentTrend);
    this.renderTrendLabel(this.currentTrend);
    this.syncWarningVisibility();
    return this.currentTrend;
  }

  dismissWarning() {
    this.dismissedUntil = Date.now() + WARNING_SUPPRESS_MS;
    this.syncWarningVisibility();
    if (this.warningTimer) window.clearTimeout(this.warningTimer);
    this.warningTimer = window.setTimeout(() => {
      this.syncWarningVisibility();
    }, WARNING_SUPPRESS_MS + 20);
  }

  renderTrendLabel(trend) {
    if (!this.trendLabelEl) return;
    this.trendLabelEl.textContent = trend;
    this.trendLabelEl.dataset.trend = trend;
  }

  syncWarningVisibility() {
    if (!this.bannerEl) return;
    const suppressed = Date.now() < this.dismissedUntil;
    const shouldShow = this.currentTrend === 'worsening' && !suppressed;
    this.bannerEl.classList.toggle('is-hidden', !shouldShow);
  }

  renderSparkline(snapshots, trend) {
    if (!this.svgEl) return;

    const vb = this.svgEl.viewBox?.baseVal;
    const width = vb?.width || 180;
    const height = vb?.height || 42;
    this.svgEl.replaceChildren();

    const baseline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    baseline.setAttribute('x1', '0');
    baseline.setAttribute('y1', String(height - 1));
    baseline.setAttribute('x2', String(width));
    baseline.setAttribute('y2', String(height - 1));
    baseline.setAttribute('stroke', '#cbd5e1');
    baseline.setAttribute('stroke-width', '1');
    this.svgEl.appendChild(baseline);

    if (snapshots.length === 0) return;

    const minTs = snapshots[0].timestamp;
    const maxTs = snapshots[snapshots.length - 1].timestamp;
    const spanTs = Math.max(1, maxTs - minTs);
    const stepX = snapshots.length > 1 ? width / (snapshots.length - 1) : width;

    const points = snapshots.map((snapshot, index) => {
      const x = maxTs === minTs
        ? index * stepX
        : ((snapshot.timestamp - minTs) / spanTs) * width;
      const y = height - (snapshot.score / 100) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', TREND_COLORS[trend] || TREND_COLORS.stable);
    line.setAttribute('stroke-width', '2.6');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('points', points.join(' '));
    this.svgEl.appendChild(line);
  }
}
