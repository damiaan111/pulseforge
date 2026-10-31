// Draws assets/icon.png from the SVG below, in Electron's own renderer so no image tool is needed.
// Run with `node_modules/electron/dist/electron.exe scripts/make-icon.mjs`, and only when the icon changes.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers/promises';
import { app, BrowserWindow } from 'electron';

const SIZE = 1024;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="face" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1830"/><stop offset="1" stop-color="#0b0a12"/></linearGradient>
    <linearGradient id="pulse" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7c5cff"/><stop offset=".55" stop-color="#ff2d95"/><stop offset="1" stop-color="#ffb347"/></linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#face)"/>
  <rect x="8.75" y="8.75" width="238.5" height="238.5" rx="51.5" fill="none" stroke="#ffffff" stroke-opacity=".09" stroke-width="1.5"/>
  <path id="p" d="M34 134 H76 L92 134 L108 70 L134 196 L154 100 L166 134 H222" fill="none" stroke="url(#pulse)" stroke-width="17" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)" opacity=".75"/>
  <path d="M34 134 H76 L92 134 L108 70 L134 196 L154 100 L166 134 H222" fill="none" stroke="url(#pulse)" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

app.disableHardwareAcceleration();
// Not a top-level await: in an ES main module that holds up the very event it waits for.
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await window.loadURL(`data:text/html;base64,${Buffer.from(`<!doctype html><body style="margin:0;background:transparent">${SVG}</body>`).toString('base64')}`);
  await setTimeout(400);
  const image = await window.webContents.capturePage();
  const target = join(dirname(import.meta.dirname), 'assets', 'icon.png');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, image.resize({ width: 512, height: 512, quality: 'best' }).toPNG());
  app.quit();
});
