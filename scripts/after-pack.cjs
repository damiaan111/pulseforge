// electron-builder's afterPack hook. On the Mac build only: signs the app ad hoc.
//
// Apple Silicon runs no unsigned code, and packing changes the app after Electron's own signature was
// made, so without this the app reports itself damaged. An ad-hoc signature costs nothing and needs no
// Apple account; it is not a Developer ID, so Gatekeeper still asks the first time (README, "Mac").
// CommonJS because electron-builder requires the hook; the rest of the repo is ES modules.

/* global require, module */
/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads this hook with require() */
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
