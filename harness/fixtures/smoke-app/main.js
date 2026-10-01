/**
 * Smoke app used by `ebb doctor` and `ebb selfcheck`.
 *
 * It is deliberately tiny and self-contained: no network, no bundler, no
 * dependencies. If this app cannot reach `ready`, the host cannot run the target
 * application either, and the failure is an environment problem rather than a
 * problem with the repository under test.
 *
 * It also writes a JSON handshake file so the harness can distinguish three
 * distinct failures: the process never started, the main script ran but Chromium
 * died during browser-process init, or the window never finished loading.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const handshakePath = path.join(__dirname, 'handshake.json');
const handshake = {
  startedAt: new Date().toISOString(),
  pid: process.pid,
  argv: process.argv.slice(1),
  versions: process.versions,
  stages: [],
};

function record(stage, extra) {
  handshake.stages.push({ stage, at: new Date().toISOString(), ...(extra ?? {}) });
  try {
    fs.writeFileSync(handshakePath, JSON.stringify(handshake, null, 2));
  } catch {}
}

record('main-script-evaluated');

app.disableHardwareAcceleration?.();

app.on('ready', () => {
  record('app-ready');
  const window = new BrowserWindow({ width: 1024, height: 768, show: true });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>ebb-smoke</title></head>
<body style="font-family: sans-serif; padding: 24px">
<h1 id="heading">ebb smoke ok</h1>
<p id="info">electron ${process.versions.electron}</p>
<button id="counter" onclick="document.getElementById('info').textContent='clicked'">click</button>
</body></html>`;
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  window.webContents.on('did-finish-load', () => record('did-finish-load'));
  window.webContents.on('render-process-gone', (_event, details) => record('render-process-gone', details));
});

app.on('window-all-closed', () => record('window-all-closed'));
process.on('uncaughtException', (error) => record('uncaught-exception', { message: error.message, stack: error.stack }));
process.on('exit', (code) => record('process-exit', { code }));

// Self-terminate so the doctor never leaks a window.
setTimeout(() => {
  record('doctor-timeout-quit');
  app.quit();
}, 25000);
