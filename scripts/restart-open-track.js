#!/usr/bin/env node

const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ORCHESTRATOR_ENTRY = path.join(ROOT, 'orchestrator.js');

function printUsageAndExit(code = 1) {
  console.log('Usage: node scripts/restart-open-track.js [folder-path] [--port 10000] [--host 0.0.0.0] [--no-open]');
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    folder: '',
    port: '10000',
    host: '0.0.0.0',
    noOpen: false,
  };

  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      printUsageAndExit(0);
    }
    if (token === '--port') {
      out.port = String(argv[i + 1] || out.port);
      i += 1;
      continue;
    }
    if (token === '--host') {
      out.host = String(argv[i + 1] || out.host);
      i += 1;
      continue;
    }
    if (token === '--no-open') {
      out.noOpen = true;
      continue;
    }
    positional.push(token);
  }

  out.folder = String(positional[0] || '').trim();
  return out;
}

function clearPort(port) {
  try {
    spawnSync('fuser', ['-k', `${port}/tcp`], { stdio: 'ignore' });
  } catch (_) {
    // no-op if fuser is unavailable
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpRequestJson(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += String(chunk);
      });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);

    if (body != null) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function waitForHealth(port, retries = 80, delayMs = 500) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: Number(port), path: '/healthz', timeout: 1500 }, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += String(chunk);
          });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode || 0, body: body.trim() });
          });
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy(new Error('timeout'));
        });
      });

      if (response.statusCode === 200 && response.body === 'ok') {
        return;
      }
    } catch (_) {
      // retry
    }

    await wait(delayMs);
  }

  throw new Error('Server did not become healthy in time');
}

function openBrowser(url) {
  let cmd = 'xdg-open';
  if (process.platform === 'darwin') cmd = 'open';
  if (process.platform === 'win32') cmd = 'start';

  const child = spawn(cmd, [url], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

async function setTracking(port, folderPath) {
  const result = await httpRequestJson(
    {
      host: '127.0.0.1',
      port: Number(port),
      path: '/api/tracking',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    },
    { path: folderPath }
  );

  if (result.statusCode < 200 || result.statusCode >= 300 || !result.body || !result.body.ok) {
    const reason = (result.body && result.body.error) ? String(result.body.error) : `status ${result.statusCode}`;
    throw new Error(`Failed to set tracking path: ${reason}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const trackedPath = options.folder ? path.resolve(process.cwd(), options.folder) : '';

  clearPort(options.port);

  const env = {
    ...process.env,
    PORT: String(options.port),
    HOST: String(options.host),
    WS_PORT: String(options.port),
  };

  const server = spawn(process.execPath, [ORCHESTRATOR_ENTRY], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!server.killed) {
      server.kill(signal);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.on('exit', (code) => {
    process.exit(code || 0);
  });

  try {
    await waitForHealth(options.port);

    const url = `http://localhost:${options.port}`;
    if (trackedPath) {
      await setTracking(options.port, trackedPath);
      console.log(`[analyze:open] tracking folder: ${trackedPath}`);
    } else {
      console.log('[analyze:open] no startup folder provided, choose a folder in the UI.');
    }
    console.log(`[analyze:open] ui: ${url}`);

    if (!options.noOpen) {
      openBrowser(url);
    }
  } catch (error) {
    console.error(`[analyze:open] ${error.message}`);
  }
}

main();
