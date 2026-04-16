# CodexMap — Extended Design Specification

> **For Codex:** This document is the authoritative build spec for CodexMap.
> Implement every section top-to-bottom. Do not add features not described here.
> Do not modify the existing four-agent architecture unless the section explicitly says so.

---

## 0. Baseline System (Already Designed — Do Not Break)

CodexMap runs four concurrent agents coordinated by `orchestrator.js`:

| Agent | File | Role |
|-------|------|------|
| A1 Generator | `agents/generator.js` | Runs Codex CLI, streams file output |
| A2 Cartographer | `agents/cartographer.js` | Filesystem watcher → `map-state.json` |
| A3 Broadcaster | `agents/broadcaster.js` | WebSocket diffs to browser on port 4242 |
| A4 Sentinel | `agents/sentinel.js` | Embedding cosine similarity → color grades |

Shared state lives in `shared/map-state.json` (write atomically: `.tmp` then rename).
Original developer prompt lives in `shared/prompt.txt`.
Browser UI uses Cytoscape.js for the node graph.

The three extensions below add new agents, new shared state files, new UI panels,
and new WebSocket message types. They must not break the existing four agents.

---

## 1. Feature: Context Drift Detection Score

### 1.1 Purpose

Track how the overall codebase alignment changes over time as Codex generates code.
Persist a time-series of Drift Score snapshots so the user can see whether drift is
accelerating or stabilizing. Display a sparkline in the UI header and a warning
banner when the trend is downward.

### 1.2 New Files

```
codexmap/
├── shared/
│   └── drift-history.json       # Time-series of drift snapshots
├── agents/
│   └── historian.js             # A5: writes snapshots to drift-history.json
└── ui/
    └── drift-chart.js           # Renders sparkline + trend warning
```

### 1.3 Agent A5 — Historian

**Responsibility:** Every time `map-state.json` changes and the `driftScore` value
changes, append a new snapshot to `drift-history.json`. Also write a snapshot on
every Git commit if a repo exists (use `simple-git` to detect commits).

**File: `agents/historian.js`**

```javascript
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');

const HISTORY_PATH = './shared/drift-history.json';
const STATE_PATH   = './shared/map-state.json';

// Initialize history file
if (!fs.existsSync(HISTORY_PATH)) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify({ snapshots: [] }));
}

let lastScore = null;

function appendSnapshot(score, trigger) {
  const raw     = fs.readFileSync(HISTORY_PATH, 'utf8');
  const history = JSON.parse(raw);

  history.snapshots.push({
    timestamp: new Date().toISOString(),
    driftScore: score,
    trigger,                     // "state_change" | "commit"
    commitHash: null,            // filled in for "commit" trigger
  });

  // Keep last 500 snapshots to bound file size
  if (history.snapshots.length > 500) history.snapshots.splice(0, history.snapshots.length - 500);

  const tmp = HISTORY_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
  fs.renameSync(tmp, HISTORY_PATH);
}

// Watch for state changes
chokidar.watch(STATE_PATH).on('change', () => {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (state.driftScore !== null && state.driftScore !== lastScore) {
      lastScore = state.driftScore;
      appendSnapshot(state.driftScore, 'state_change');
    }
  } catch (_) {}
});

// Watch for Git commits (poll every 5s if simple-git available)
const git = simpleGit('./output');
let lastCommit = null;

setInterval(async () => {
  try {
    const log = await git.log({ maxCount: 1 });
    const hash = log.latest?.hash;
    if (hash && hash !== lastCommit) {
      lastCommit = hash;
      const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      const snap = history.snapshots[history.snapshots.length - 1];
      if (snap) {
        snap.commitHash = hash;
        snap.trigger = 'commit';
        const tmp = HISTORY_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(JSON.parse(fs.readFileSync(HISTORY_PATH)), null, 2));
        fs.renameSync(tmp, HISTORY_PATH);
      }
    }
  } catch (_) {}
}, 5000);
```

**Install:** `npm install simple-git`

### 1.4 Drift History Schema

```json
{
  "snapshots": [
    {
      "timestamp": "2026-04-16T10:00:00Z",
      "driftScore": 91,
      "trigger": "state_change",
      "commitHash": null
    },
    {
      "timestamp": "2026-04-16T10:04:30Z",
      "driftScore": 74,
      "trigger": "commit",
      "commitHash": "a3f1b9c"
    }
  ]
}
```

### 1.5 Broadcaster Changes

Add `drift-history.json` to A3's watch list. When it changes, broadcast:

```json
{ "type": "drift_history_update", "payload": { "snapshots": [...] } }
```

Also send a `full_drift_history` message on reconnect (same pattern as `full_reset`).

### 1.6 Trend Detection Algorithm

Compute trend in `ui/drift-chart.js`. Use a 5-snapshot rolling window:

```javascript
function computeTrend(snapshots) {
  if (snapshots.length < 2) return 'stable';
  const window = snapshots.slice(-5);
  const first  = window[0].driftScore;
  const last   = window[window.length - 1].driftScore;
  const delta  = last - first;
  if (delta <= -10) return 'worsening';   // dropped 10+ points in last 5 snaps
  if (delta >= 5)  return 'improving';
  return 'stable';
}
```

### 1.7 UI — Drift Sparkline

**Location:** Inline in the header bar, immediately to the right of the Drift Score badge.

**Rendering:** Use an inline SVG sparkline (no library needed). Plot the last 30 snapshots.
X-axis = time (normalized), Y-axis = driftScore (0–100).

Line color rules:
- `improving` → `#22c55e`
- `stable`    → `#94a3b8`
- `worsening` → `#ef4444`

**Warning banner:** When `trend === 'worsening'`, show a dismissible banner below the
header with the exact text:

> ⚠️ Drift increasing — context likely weakening. Review red and yellow nodes.

Banner color: `#fef3c7` background, `#92400e` text. Include a dismiss (×) button.
Do not show the banner again for 60 seconds after the user dismisses it.

---

## 2. Feature: Self-Healing Mode

### 2.1 Purpose

When a node's grade is `"red"`, CodexMap can automatically trigger a scoped Codex
re-invocation on that file to restore alignment with the original prompt. This creates
a closed-loop, self-correcting agent system. Self-healing can be triggered manually
(button click) or automatically when auto-heal is enabled.

### 2.2 New Files

```
codexmap/
├── agents/
│   └── healer.js                # A6: manages the heal queue and Codex re-invocations
└── shared/
    └── heal-queue.json          # Queue of nodes awaiting or undergoing healing
```

### 2.3 Heal Queue Schema

```json
{
  "queue": [
    {
      "nodeId": "src/auth/refresh.ts",
      "status": "pending",       // "pending" | "healing" | "done" | "failed"
      "triggeredBy": "auto",     // "auto" | "manual"
      "enqueuedAt": "2026-04-16T10:10:00Z",
      "startedAt": null,
      "completedAt": null,
      "attemptCount": 0,
      "lastScore": 0.42,
      "reanchorOutputFlag": true  // Sentinel must skip this node while flag is true
    }
  ]
}
```

### 2.4 Agent A6 — Healer

**Responsibility:** Watch `heal-queue.json` for `"pending"` entries. For each, spawn
a scoped Codex CLI re-invocation targeting only that file. Mark the entry `"healing"`
while Codex runs, then `"done"` or `"failed"` based on exit code. Cap at 2 attempts
per node per session to prevent infinite loops.

**File: `agents/healer.js`**

```javascript
const { spawn } = require('child_process');
const fs = require('fs');
const chokidar = require('chokidar');

const QUEUE_PATH  = './shared/heal-queue.json';
const PROMPT_PATH = './shared/prompt.txt';

const MAX_ATTEMPTS = 2;
let healing = false; // process one at a time

function readQueue()  { return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')); }
function writeQueue(q) {
  const tmp = QUEUE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2));
  fs.renameSync(tmp, QUEUE_PATH);
}

function buildHealPrompt(nodeId, originalPrompt) {
  return `
The file at ${nodeId} has drifted from the original intent of this project.
Original project prompt: ${originalPrompt}

Rewrite ${nodeId} so that it strictly and completely fulfills the responsibilities
described in the original prompt above. Rules:
- Do not add features, classes, or functions not described in the original prompt.
- Do not change any other files.
- Preserve the programming language and file extension.
- Output only the rewritten file.
`.trim();
}

async function processQueue() {
  if (healing) return;
  const q = readQueue();
  const next = q.queue.find(e => e.status === 'pending' && e.attemptCount < MAX_ATTEMPTS);
  if (!next) return;

  healing = true;
  next.status      = 'healing';
  next.startedAt   = new Date().toISOString();
  next.attemptCount += 1;
  writeQueue(q);

  const prompt = fs.readFileSync(PROMPT_PATH, 'utf8').trim();
  const healPrompt = buildHealPrompt(next.nodeId, prompt);

  const codex = spawn('codex', ['--approval-mode', 'auto-edit', healPrompt], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  codex.on('close', (code) => {
    const q2 = readQueue();
    const entry = q2.queue.find(e => e.nodeId === next.nodeId && e.status === 'healing');
    if (entry) {
      entry.status      = code === 0 ? 'done' : 'failed';
      entry.completedAt = new Date().toISOString();
      // Keep reanchorOutputFlag true until Sentinel re-scores the node
    }
    writeQueue(q2);
    healing = false;
    // Check for more items
    setTimeout(processQueue, 500);
  });
}

// Initialize queue file
if (!fs.existsSync(QUEUE_PATH)) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify({ queue: [] }));
}

// Watch for new items in queue
chokidar.watch(QUEUE_PATH).on('change', processQueue);
processQueue();
```

### 2.5 Sentinel Changes — Skip Healing Nodes

In `agents/sentinel.js`, before scoring any node, check `heal-queue.json`:

```javascript
function isBeingHealed(nodeId) {
  const q = JSON.parse(fs.readFileSync('./shared/heal-queue.json', 'utf8'));
  return q.queue.some(e => e.nodeId === nodeId && e.reanchorOutputFlag && e.status !== 'done');
}

// In the main scoring loop:
if (isBeingHealed(node.id)) return; // skip; will re-score when healing is done
```

After Sentinel scores a node that was in the queue with `status === "done"`,
clear `reanchorOutputFlag` for that entry:

```javascript
function clearHealFlag(nodeId) {
  const q = JSON.parse(fs.readFileSync('./shared/heal-queue.json', 'utf8'));
  const entry = q.queue.find(e => e.nodeId === nodeId);
  if (entry) entry.reanchorOutputFlag = false;
  writeQueue(q); // atomic write
}
```

### 2.6 UI — Self-Healing Controls

**Auto-heal toggle:** Add a toggle switch in the header bar labelled **"Auto-Heal"**.
Default: OFF. When ON, the UI sends a `{ type: "set_autoheal", enabled: true }` message
to the Broadcaster over the same WebSocket.

**Broadcaster changes:** A3 must handle `set_autoheal` messages from the browser.
Write `{ "autoHeal": true }` to `shared/settings.json` (atomic write).

**A6 Healer — auto-heal behaviour:** On each `map-state.json` change, if
`shared/settings.json` has `autoHeal: true`, automatically enqueue every node whose
`grade === "red"` and that is not already in the queue (any status):

```javascript
function autoEnqueueRedNodes(state) {
  const settings = JSON.parse(fs.readFileSync('./shared/settings.json', 'utf8'));
  if (!settings.autoHeal) return;

  const q = readQueue();
  const alreadyQueued = new Set(q.queue.map(e => e.nodeId));

  state.nodes
    .filter(n => n.grade === 'red' && !alreadyQueued.has(n.id))
    .forEach(n => {
      q.queue.push({
        nodeId:           n.id,
        status:           'pending',
        triggeredBy:      'auto',
        enqueuedAt:       new Date().toISOString(),
        startedAt:        null,
        completedAt:      null,
        attemptCount:     0,
        lastScore:        n.score,
        reanchorOutputFlag: true,
      });
    });

  writeQueue(q);
}
```

**Manual heal button:** In the node detail panel, every red node shows a
**"Self-Heal"** button (in addition to the existing Re-anchor button). Clicking it
sends `{ type: "manual_heal", nodeId: "<id>" }` over WebSocket. A3 receives this,
appends the node to `heal-queue.json` with `triggeredBy: "manual"`.

**Heal status badge in UI:** Each node in the Cytoscape graph that has an active
heal-queue entry shows a pulsing ring around it using the following Cytoscape style:

```javascript
cy.style()
  .selector('node[healStatus="healing"]')
    .css({ 'border-color': '#a78bfa', 'border-width': 4, 'border-style': 'dashed' })
  .selector('node[healStatus="done"]')
    .css({ 'border-color': '#22c55e', 'border-width': 2 })
  .selector('node[healStatus="failed"]')
    .css({ 'border-color': '#ef4444', 'border-width': 2, 'border-style': 'dotted' })
  .update();
```

A3 must broadcast `{ type: "heal_status_update", payload: { nodeId, status } }` on
every heal-queue change so the UI can apply these styles in real time.

---

## 3. Feature: Architectural Collapse Warning

### 3.1 Purpose

Monitor three structural signals simultaneously: density of red nodes, inter-file
dependency graph complexity (edge-to-node ratio), and cyclomatic complexity of
individual functions. When any signal crosses a threshold, emit an
**"Architecture destabilizing"** warning with the specific cause identified.

### 3.2 New Files

```
codexmap/
├── agents/
│   └── architect.js             # A7: monitors structural health metrics
├── shared/
│   └── arch-health.json         # Current metric values + warning state
└── scripts/
    └── cyclomatic.js            # Cyclomatic complexity calculator
```

### 3.3 Metrics Tracked

| Metric | Field in arch-health.json | Warning threshold |
|--------|--------------------------|-------------------|
| Red node ratio | `redNodeRatio` | > 0.35 (35% of scored nodes are red) |
| Dependency complexity | `depComplexity` | Edge-to-node ratio > 3.5 |
| Max cyclomatic complexity | `maxCyclomatic` | Any single function > 15 |
| Composite collapse score | `collapseScore` | > 70 (see §3.6) |

### 3.4 Agent A7 — Architect

**Responsibility:** After every `map-state.json` change, recompute all four metrics
and write `arch-health.json`. Emit warnings when thresholds are breached.

**File: `agents/architect.js`**

```javascript
const chokidar = require('chokidar');
const fs = require('fs');
const { computeCyclomatic } = require('../scripts/cyclomatic');

const STATE_PATH  = './shared/map-state.json';
const ARCH_PATH   = './shared/arch-health.json';

function computeRedNodeRatio(nodes) {
  const scored = nodes.filter(n => n.grade !== 'pending');
  if (scored.length === 0) return 0;
  const red = scored.filter(n => n.grade === 'red').length;
  return red / scored.length;
}

function computeDepComplexity(nodes, edges) {
  if (nodes.length === 0) return 0;
  return edges.length / nodes.length;
}

function computeMaxCyclomatic(nodes) {
  let max = 0;
  for (const node of nodes.filter(n => n.type === 'function' && n.code)) {
    const score = computeCyclomatic(node.code);
    if (score > max) max = score;
  }
  return max;
}

// Composite score: weighted sum, scaled to 0–100
function computeCollapseScore(redRatio, depComplexity, maxCyclo) {
  const redComponent   = Math.min(redRatio / 0.35, 1)  * 40; // weight 40
  const depComponent   = Math.min(depComplexity / 3.5, 1) * 30; // weight 30
  const cycloComponent = Math.min(maxCyclo / 15, 1) * 30; // weight 30
  return Math.round(redComponent + depComponent + cycloComponent);
}

function buildWarnings(metrics) {
  const warnings = [];
  if (metrics.redNodeRatio > 0.35)
    warnings.push({ code: 'RED_NODE_DENSITY', message: `${Math.round(metrics.redNodeRatio * 100)}% of nodes are out of spec.` });
  if (metrics.depComplexity > 3.5)
    warnings.push({ code: 'DEP_COMPLEXITY', message: `Dependency graph complexity is ${metrics.depComplexity.toFixed(1)} (threshold: 3.5).` });
  if (metrics.maxCyclomatic > 15)
    warnings.push({ code: 'CYCLOMATIC', message: `A function has cyclomatic complexity ${metrics.maxCyclomatic} (threshold: 15).` });
  return warnings;
}

chokidar.watch(STATE_PATH).on('change', () => {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const redNodeRatio  = computeRedNodeRatio(state.nodes);
    const depComplexity = computeDepComplexity(state.nodes, state.edges);
    const maxCyclomatic = computeMaxCyclomatic(state.nodes);
    const collapseScore = computeCollapseScore(redNodeRatio, depComplexity, maxCyclomatic);
    const warnings      = buildWarnings({ redNodeRatio, depComplexity, maxCyclomatic });

    const health = {
      redNodeRatio:  parseFloat(redNodeRatio.toFixed(3)),
      depComplexity: parseFloat(depComplexity.toFixed(3)),
      maxCyclomatic,
      collapseScore,
      warnings,
      destabilizing: collapseScore > 70,
      lastUpdated:   new Date().toISOString(),
    };

    const tmp = ARCH_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(health, null, 2));
    fs.renameSync(tmp, ARCH_PATH);
  } catch (e) {
    console.error('[architect] error:', e.message);
  }
});
```

### 3.5 Cyclomatic Complexity Calculator

**File: `scripts/cyclomatic.js`**

Cyclomatic complexity = number of decision points + 1.
Count decision points by scanning the AST for: `if`, `else if`, `for`, `while`,
`do`, `switch case`, `&&`, `||`, `??`, ternary `?`.

```javascript
// scripts/cyclomatic.js
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

function computeCyclomatic(code) {
  let complexity = 1; // base
  try {
    const ast = parser.parse(code, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
    traverse(ast, {
      IfStatement()         { complexity++; },
      ForStatement()        { complexity++; },
      ForInStatement()      { complexity++; },
      ForOfStatement()      { complexity++; },
      WhileStatement()      { complexity++; },
      DoWhileStatement()    { complexity++; },
      SwitchCase()          { complexity++; },
      LogicalExpression(path) {
        if (['&&', '||', '??'].includes(path.node.operator)) complexity++;
      },
      ConditionalExpression() { complexity++; },
      CatchClause()          { complexity++; },
    });
  } catch (_) {
    return 1; // unparseable code gets base complexity
  }
  return complexity;
}

module.exports = { computeCyclomatic };
```

### 3.6 Broadcaster Changes

A3 must also watch `arch-health.json`. When it changes, broadcast:

```json
{ "type": "arch_health_update", "payload": { ...arch-health contents... } }
```

On reconnect, send `{ "type": "full_arch_health", "payload": { ... } }`.

### 3.7 UI — Architectural Collapse Warning

**Collapse Score meter:** In the header bar, add a circular progress indicator
labelled **"Arch Health"** showing `100 - collapseScore` (so 100 = healthy, 0 = collapsed).

Color rules:
- Score 70–100 → green (`#22c55e`)
- Score 40–69  → yellow (`#f59e0b`)
- Score 0–39   → red (`#ef4444`)

**Destabilizing banner:** When `arch-health.json` has `"destabilizing": true`,
show a dismissible full-width banner with a red background (`#fca5a5` background,
`#7f1d1d` text) and the message:

> 🏚️ Architecture destabilizing. [Specific causes listed from warnings array.]

Each warning in the array is rendered as a separate sentence in the banner.
For example:
> 🏚️ Architecture destabilizing. 38% of nodes are out of spec. Dependency graph complexity is 4.1 (threshold: 3.5).

**Architecture panel:** Clicking the "Arch Health" meter in the header opens
a right-side drawer (same pattern as the node detail panel) titled
**"Architecture Health"** showing:

- A table of the four metrics with current values and thresholds.
- A badge per metric: green ✓ or red ✗.
- A list of active warnings with their codes and messages.
- A "Heal All Red Nodes" button that enqueues all red nodes into the heal queue
  (requires Self-Healing Mode feature to be present).

---

## 4. Orchestrator Changes

Update `orchestrator.js` to spawn the three new agents after the original four.
Maintain start order: Cartographer → Broadcaster → Sentinel → Historian → Architect → Healer → Generator.
Generator must always start last.

```javascript
// orchestrator.js — updated agents array
const agents = [
  fork('./agents/cartographer.js'),
  fork('./agents/broadcaster.js'),
  fork('./agents/sentinel.js'),
  fork('./agents/historian.js'),   // NEW — A5
  fork('./agents/architect.js'),   // NEW — A7
  fork('./agents/healer.js'),      // NEW — A6
  fork('./agents/generator.js'),   // LAST
];
```

Initialize new shared state files at startup:

```javascript
// Add to orchestrator.js startup block
fs.writeFileSync('./shared/drift-history.json', JSON.stringify({ snapshots: [] }));
fs.writeFileSync('./shared/heal-queue.json',    JSON.stringify({ queue: [] }));
fs.writeFileSync('./shared/arch-health.json',   JSON.stringify({
  redNodeRatio: 0, depComplexity: 0, maxCyclomatic: 0,
  collapseScore: 0, warnings: [], destabilizing: false, lastUpdated: null
}));
fs.writeFileSync('./shared/settings.json',      JSON.stringify({ autoHeal: false }));
```

---

## 5. WebSocket Message Reference (Complete, Including New Types)

| Message type | Direction | Payload |
|---|---|---|
| `graph_update` | Server → Browser | Array of changed/added nodes and edges |
| `node_grade` | Server → Browser | `{ id, grade, score }` |
| `full_reset` | Server → Browser | Complete `map-state.json` on reconnect |
| `generation_done` | Server → Browser | Signal Codex finished |
| `drift_history_update` | Server → Browser | `{ snapshots: [...] }` |
| `full_drift_history` | Server → Browser | Full history on reconnect |
| `arch_health_update` | Server → Browser | `arch-health.json` contents |
| `full_arch_health` | Server → Browser | Full arch health on reconnect |
| `heal_status_update` | Server → Browser | `{ nodeId, status }` |
| `set_autoheal` | Browser → Server | `{ enabled: true/false }` |
| `manual_heal` | Browser → Server | `{ nodeId: "..." }` |

---

## 6. Updated File & Directory Layout

```
codexmap/
├── orchestrator.js
├── agents/
│   ├── generator.js        # A1 (existing)
│   ├── cartographer.js     # A2 (existing)
│   ├── broadcaster.js      # A3 (modified: new message types)
│   ├── sentinel.js         # A4 (modified: skip healing nodes)
│   ├── historian.js        # A5 (NEW)
│   ├── healer.js           # A6 (NEW)
│   └── architect.js        # A7 (NEW)
├── shared/
│   ├── map-state.json      # (existing)
│   ├── prompt.txt          # (existing)
│   ├── drift-history.json  # (NEW)
│   ├── heal-queue.json     # (NEW)
│   ├── arch-health.json    # (NEW)
│   └── settings.json       # (NEW)
├── ui/
│   ├── index.html          # (modified: new header elements, new panels)
│   ├── graph.js            # (modified: heal status badge styles)
│   ├── panel.js            # (modified: Self-Heal button, Arch Health panel)
│   └── drift-chart.js      # (NEW)
└── scripts/
    ├── embed.py            # (existing)
    ├── similarity.py       # (existing)
    └── cyclomatic.js       # (NEW)
```

---

## 7. Install & Dependencies

```bash
# New dependencies for the three features
npm install simple-git          # Historian: Git commit detection
# @babel/traverse already implied by @babel/parser for cyclomatic

pip install openai numpy        # (unchanged)
```

Full install sequence:

```bash
npm install chokidar ws @babel/parser @babel/traverse tree-sitter simple-git
pip install openai numpy
```

---

## 8. Common Pitfalls for These Features

| Pitfall | Fix |
|---------|-----|
| Historian appends duplicate snapshots | Only append when `driftScore` actually changes; compare with `lastScore` |
| Healer causes infinite re-score loop | `reanchorOutputFlag = true` blocks Sentinel until heal is `done` |
| Architect computes cyclomatic on minified code | Skip nodes whose `code` length > 100k chars |
| Architect fires on every keystroke | Debounce `map-state.json` watch by 1000ms in A7 (not 300ms like A2) |
| Auto-heal re-enqueues a node that already failed | Check `status` not just `nodeId`; skip if `attemptCount >= MAX_ATTEMPTS` |
| Collapse Score jumps on startup (0 scored nodes) | Return `collapseScore = 0` and `destabilizing = false` until at least 5 nodes are scored |
| Drift chart renders with wrong Y-axis (scores > 100) | Clamp `driftScore` to 0–100 before plotting |
| Broadcaster sends arch_health on every state change | A7 owns arch-health.json; A3 watches that file, not map-state.json |
