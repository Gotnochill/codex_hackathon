const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHARED_DIR = path.join(ROOT, 'shared');
const TRACKING_PATH = path.join(SHARED_DIR, 'tracking.json');

function atomicWriteJson(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function printUsageAndExit() {
  console.error('Usage: npm run track:init -- <folder-path>');
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) {
  printUsageAndExit();
}

const trackedPath = path.resolve(process.cwd(), arg);
ensureDir(trackedPath);

if (!fs.statSync(trackedPath).isDirectory()) {
  console.error(`[track:init] path is not a directory: ${trackedPath}`);
  process.exit(1);
}

ensureDir(SHARED_DIR);
atomicWriteJson(TRACKING_PATH, {
  trackedPath,
  updatedAt: new Date().toISOString(),
});

console.log(`[track:init] tracking folder set to: ${trackedPath}`);
