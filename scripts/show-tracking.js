const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TRACKING_PATH = path.join(ROOT, 'shared', 'tracking.json');
const DEFAULT_TRACKED_PATH = path.join(ROOT, 'output');

let trackedPath = DEFAULT_TRACKED_PATH;
try {
  const data = JSON.parse(fs.readFileSync(TRACKING_PATH, 'utf8'));
  if (data && typeof data.trackedPath === 'string') {
    trackedPath = path.resolve(String(data.trackedPath));
  }
} catch (_) {
  // Use default if file is missing/unreadable.
}

console.log(trackedPath);
