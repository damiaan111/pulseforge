// Electron main process for the spike: a hidden window whose renderer does the GPU work.
// No app shell — P0 only needs a WebGL2 context on the real GPU.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import type { SpikeRenderConfig, SpikeRenderResult } from './protocol.ts';

// Pin the ANGLE backend so results are comparable across runs and recorded in the report.
app.commandLine.appendSwitch('use-angle', 'd3d11');
app.commandLine.appendSwitch('force_high_performance_gpu');

const configJson = process.env['PULSEFORGE_SPIKE_CONFIG'];
if (configJson === undefined) {
  console.error('PULSEFORGE_SPIKE_CONFIG is not set; run the spike through `npm run spike:determinism`.');
  process.exit(2);
}
const config = JSON.parse(configJson) as SpikeRenderConfig;

function fail(message: string): void {
  const result: SpikeRenderResult = {
    ok: false,
    error: message,
    width: config.width,
    height: config.height,
    frameCount: config.frameCount,
    warnings: [],
    paramIssues: [],
  };
  writeFileSync(config.resultFile, JSON.stringify(result, null, 2));
  app.exit(1);
}

const timeout = setTimeout(() => fail('renderer did not finish within 15 minutes'), 15 * 60_000);

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    webPreferences: {
      // Spike only: the renderer hashes and writes frames itself. The export pipe
      // arrangement (which process talks to FFmpeg) is decided in step 4.
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.on('render-process-gone', (_event, details) => fail(`renderer process gone: ${details.reason}`));
  ipcMain.once('spike-config', (event) => {
    event.returnValue = config;
  });
  ipcMain.once('spike-done', (_event, result: SpikeRenderResult) => {
    clearTimeout(timeout);
    writeFileSync(config.resultFile, JSON.stringify(result, null, 2));
    app.exit(result.ok ? 0 : 1);
  });
  await window.loadFile(join(__dirname, 'index.html'));
});
