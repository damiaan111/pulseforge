// Electron main process for the spikes: a hidden window whose renderer does the GPU work.
// No app shell — P0 only needs a WebGL2 context on the real GPU.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import type { SpikeConfig } from './protocol.ts';

// Pin the ANGLE backend so results are comparable across runs and recorded in the report.
app.commandLine.appendSwitch('use-angle', 'd3d11');
app.commandLine.appendSwitch('force_high_performance_gpu');

const configJson = process.env['PULSEFORGE_SPIKE_CONFIG'];
if (configJson === undefined) {
  console.error('PULSEFORGE_SPIKE_CONFIG is not set; run a spike through `npm run spike:determinism` or `npm run spike:export`.');
  process.exit(2);
}
const config = JSON.parse(configJson) as SpikeConfig;

function fail(message: string): void {
  writeFileSync(config.resultFile, JSON.stringify({ ok: false, error: message, warnings: [], paramIssues: [] }, null, 2));
  app.exit(1);
}

const timeout = setTimeout(() => fail('renderer did not finish within 60 minutes'), 60 * 60_000);

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    webPreferences: {
      // The renderer both drives WebGL2 and writes to FFmpeg's stdin, so frames never cross
      // an IPC boundary (export-spec §4.2). Spike-grade security settings; the app shell will
      // revisit how this process gets Node access.
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.on('render-process-gone', (_event, details) => fail(`renderer process gone: ${details.reason}`));
  ipcMain.once('spike-config', (event) => {
    event.returnValue = config;
  });
  ipcMain.on('spike-progress', (_event, line: string) => {
    process.stdout.write(`PROGRESS ${line}\n`);
  });
  ipcMain.once('spike-done', (_event, result: { ok: boolean }) => {
    clearTimeout(timeout);
    writeFileSync(config.resultFile, JSON.stringify(result, null, 2));
    app.exit(result.ok ? 0 : 1);
  });
  await window.loadFile(join(__dirname, 'index.html'));
});
