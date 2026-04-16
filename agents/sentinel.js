const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'shared', 'map-state.json');
const PROMPT_PATH = path.join(ROOT, 'shared', 'prompt.txt');
const HEAL_QUEUE_PATH = path.join(ROOT, 'shared', 'heal-queue.json');
const EMBED_SCRIPT = path.join(ROOT, 'scripts', 'embed.py');
const SIMILARITY_SCRIPT = path.join(ROOT, 'scripts', 'similarity.py');
const DEBOUNCE_MS = 450;

const GREEN_THRESHOLD = 0.75;
const YELLOW_THRESHOLD = 0.45;

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

function clamp01(value) {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function scoreToGrade(score) {
  if (score >= GREEN_THRESHOLD) return 'green';
  if (score >= YELLOW_THRESHOLD) return 'yellow';
  return 'red';
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function cosine(a, b) {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function fallbackEmbedding(text) {
  const DIM = 128;
  const vec = new Array(DIM).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const idx = Math.abs(hash) % DIM;
    vec[idx] += 1;
  }
  const mag = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  if (mag === 0) return vec;
  return vec.map((v) => v / mag);
}

function runPython(scriptPath, inputObject) {
  const result = spawnSync('python3', [scriptPath], {
    input: JSON.stringify(inputObject),
    encoding: 'utf8',
    timeout: 30000,
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  try {
    return JSON.parse(result.stdout || '{}');
  } catch (_) {
    return null;
  }
}

function embedTexts(texts) {
  if (texts.length === 0) return [];

  const response = runPython(EMBED_SCRIPT, { texts });
  if (response && Array.isArray(response.embeddings) && response.embeddings.length === texts.length) {
    return response.embeddings;
  }

  return texts.map((text) => fallbackEmbedding(text));
}

function similarityScores(promptEmbedding, embeddings) {
  if (embeddings.length === 0) return [];

  const pairs = embeddings.map((embedding) => ({ a: promptEmbedding, b: embedding }));
  const response = runPython(SIMILARITY_SCRIPT, { pairs });
  if (response && Array.isArray(response.scores) && response.scores.length === embeddings.length) {
    return response.scores.map((score) => clamp01(Number(score)));
  }

  return embeddings.map((embedding) => clamp01(cosine(promptEmbedding, embedding)));
}

function isBeingHealed(nodeId, queue) {
  return (queue.queue || []).some(
    (entry) => entry.nodeId === nodeId && entry.reanchorOutputFlag && entry.status !== 'done'
  );
}

let busy = false;
let rerun = false;
let debounceTimer = null;

function scheduleScoring() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    scoreState();
  }, DEBOUNCE_MS);
}

function scoreState() {
  if (busy) {
    rerun = true;
    return;
  }
  busy = true;

  try {
    const state = safeReadJson(STATE_PATH, { nodes: [], edges: [], driftScore: null, lastUpdated: null });
    const queue = safeReadJson(HEAL_QUEUE_PATH, { queue: [] });
    const prompt = fs.existsSync(PROMPT_PATH) ? fs.readFileSync(PROMPT_PATH, 'utf8').trim() : '';

    const nodes = Array.isArray(state.nodes) ? state.nodes : [];

    const candidates = nodes.filter((node) => {
      if (!node || typeof node.id !== 'string') return false;
      if (isBeingHealed(node.id, queue)) return false;
      return typeof node.code === 'string' && node.code.trim().length > 0;
    });

    const scoredNodeIds = new Set(candidates.map((node) => node.id));

    let changed = false;
    let queueChanged = false;

    if (candidates.length > 0) {
      const promptEmbedding = embedTexts([prompt])[0] || fallbackEmbedding(prompt);
      const nodeEmbeddings = embedTexts(candidates.map((node) => node.code));
      const scores = similarityScores(promptEmbedding, nodeEmbeddings);

      candidates.forEach((node, index) => {
        const rawScore = Number(scores[index]);
        const score = clamp01(Number.isFinite(rawScore) ? rawScore : 0);
        const rounded = Number(score.toFixed(4));
        const grade = scoreToGrade(score);

        if (node.score !== rounded || node.grade !== grade) {
          node.score = rounded;
          node.grade = grade;
          changed = true;
        }

        const entry = (queue.queue || []).find((item) => item.nodeId === node.id);
        if (entry && entry.status === 'done' && entry.reanchorOutputFlag) {
          entry.reanchorOutputFlag = false;
          queueChanged = true;
        }
      });
    }

    // Preserve pending status for nodes not scored this pass.
    for (const node of nodes) {
      if (!scoredNodeIds.has(node.id)) {
        if (node.grade == null) {
          node.grade = 'pending';
          changed = true;
        }
        if (node.score == null) {
          node.score = null;
        }
      }
    }

    const numericScores = nodes
      .map((node) => (typeof node.score === 'number' ? node.score : null))
      .filter((value) => typeof value === 'number');

    const driftScore =
      numericScores.length > 0
        ? Math.round((numericScores.reduce((sum, value) => sum + value, 0) / numericScores.length) * 100)
        : null;

    if (state.driftScore !== driftScore) {
      state.driftScore = driftScore;
      changed = true;
    }

    if (changed) {
      state.lastUpdated = new Date().toISOString();
      atomicWriteJson(STATE_PATH, state);
    }

    // Persist queue reanchor flag clearing if needed.
    if (queueChanged) {
      atomicWriteJson(HEAL_QUEUE_PATH, queue);
    }
  } catch (error) {
    console.error('[sentinel] scoring error:', error.message);
  } finally {
    busy = false;
    if (rerun) {
      rerun = false;
      scheduleScoring();
    }
  }
}

if (!fs.existsSync(HEAL_QUEUE_PATH)) {
  atomicWriteJson(HEAL_QUEUE_PATH, { queue: [] });
}

if (!fs.existsSync(STATE_PATH)) {
  atomicWriteJson(STATE_PATH, { nodes: [], edges: [], driftScore: null, lastUpdated: null });
}

const watcher = chokidar.watch([STATE_PATH, HEAL_QUEUE_PATH, PROMPT_PATH], {
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 200,
    pollInterval: 40,
  },
});

watcher
  .on('add', scheduleScoring)
  .on('change', scheduleScoring)
  .on('error', (error) => {
    console.error('[sentinel] watcher error:', error.message);
  });
