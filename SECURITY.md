# Security

## Reporting a problem

Please report a security problem privately: on GitHub, open the repository's **Security** tab and choose **Report a
vulnerability**. That reaches the maintainer without making the details public. If you cannot use that, open an issue
that says only that you have a security report, and no details.

Say what you did, what happened and which version you used. You will get an answer, and a fix is released as a new
version; the release notes say what it was once people have had time to update.

Only the newest release is fixed. Older releases are withdrawn rather than patched.

## What Pulseforge does and does not do

- It has no account, no telemetry and no crash upload. Nothing you make leaves your computer.
- It goes online in two places, both started by you: installing components (pinned addresses in `setup/manifest.ts`,
  every file checked against a SHA-256 before it is used) and **Settings → Check for updates** (the releases of this
  repository only, installed after the download matches the SHA-256 in the release notes).
- The studio window is a sandboxed page with context isolation, no Node access and a content security policy. Every
  network request from it is refused, navigation and new windows are blocked, and it reaches the rest of the app only
  through the functions listed in `src/shell/ipc.ts`, whose arguments are validated on the other side.
- Shaders you add (drop-in modules, Shadertoy code, ISF files) are GLSL: they run on the graphics card and cannot read
  files or use the network. MilkDrop presets are scripts; they are generated at setup from one pinned, checksummed
  package and are loaded from that folder only. Do not replace them with files from elsewhere.
- Project files (`.pvproj`) are JSON and are parsed as data. Opening one runs no code from it.

## Checking a download

Every release lists the SHA-256 of its installer. Compare before you run it:

```
Get-FileHash .\Pulseforge-Setup-<version>.exe -Algorithm SHA256      (Windows PowerShell)
shasum -a 256 Pulseforge-<version>-arm64.dmg                          (Mac Terminal)
```

The installers are not code-signed (Windows) and signed ad hoc (Mac), so the operating system warns the first time.
Download them only from this repository's Releases page.

## What a diagnostics report contains

**Settings → Diagnostics → Copy diagnostics** puts the app's version, your graphics card and driver, the settings, and
the paths of the folders it uses on the clipboard. Nothing is sent anywhere. Read it before pasting it in public: the
paths can contain your user name.
