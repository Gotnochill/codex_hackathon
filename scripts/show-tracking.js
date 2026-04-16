const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TRACKING_PATH = path.join(ROOT, 'shared', 'tracking.json');

let trackedPath = null;
try {
  const data = JSON.parse(fs.readFileSync(TRACKING_PATH, 'utf8'));
  if (data && typeof data.trackedPath === 'string' && data.trackedPath.trim()) {
    trackedPath = path.resolve(String(data.trackedPath).trim());
  }
} catch (_) {
  // Keep null if file is missing/unreadable.
}

console.log(trackedPath || '(unset)');
