# Pulseforge — context for Claude Code

Self-hosted, GPU-accelerated audio visualizer and music-video renderer. Electron + TypeScript +
WebGL2, with a Python ML sidecar (Demucs, WhisperX) and FFmpeg export (NVENC, or software H.264).

**The planning phase is complete. Everything is specified. Read before writing code.**

## Read these first

| Order | Document | What it gives you |
|---|---|---|
| 0 | `docs/STATUS.md` | **Where the build is right now**: what is done, what is not, how to run and verify it, known issues, next step. Update it at the end of every step |
| 0 | `docs/ROADMAP.md` | **Every requirement (M1–M40, S1–S19) with its state and what is left**, the order of the remaining work (§3), and deviations from the specs awaiting the owner (§4). Update it with STATUS |
| 1 | `PROJECT.md` | Vision, locked decisions, hardware envelope, architecture, all 40 must-haves, milestones, risks |
| 2 | `docs/decisions.md` | **Authoritative.** 50 resolved decisions. Where a spec's "open questions" disagrees, this wins |
| 3 | `docs/coverage-audit.md` | Map of which document specifies what |
| 4 | The spec for whatever you're building | module · modulation · auto-director · export · lyrics · ui · compositor · data-formats |

Do not re-litigate settled decisions. If one looks wrong, say so and explain why — don't silently
deviate.

## Target hardware

Ryzen 7 · **RTX 3060 12 GB (Ampere)** · Windows 11. NVENC H.264 and HEVC only — **no AV1 encode**
on Ampere. Probe capabilities and hide unsupported options rather than failing at render time.

## Non-negotiable constraints

1. **Determinism.** `renderFrame(project, analysis, t)` must be byte-identical for the same inputs, every time. No `Date.now()`, no `performance.now()`, no rAF deltas, no `Math.random()`, no live `AnalyserNode` anywhere in the engine. Time is always a parameter; randomness always comes from the seeded PRNG.
2. **Engine boundary.** `src/engine/` must not import Electron, the DOM, React, or anything time- or network-aware. Enforce with a lint rule from the first commit. This is what keeps headless rendering, golden-frame tests and the CLI possible.
3. **Offline after setup.** No runtime CDN links, no Google Fonts, no update checks, no implicit downloads. Everything resolves from `vendor/` or the user's disk.
   Sole exception (D52): Settings → Check for updates, which reaches GitHub only when pressed.
4. **Nothing is silently dropped.** Unknown modules, missing assets, broken modulation targets — all preserved and reported, never discarded.
5. **Exact time.** Integer ticks at 1/48000 s; `fps` as a rational; frame time derived from the frame index, never accumulated.

## Conventions

- TypeScript strict. Named exports. No default exports.
- Every project mutation is an undoable command.
- Module parameters are declared as schema; the inspector UI generates itself. Never hand-write a parameter form.
- Comment density and naming follow the surrounding code.
- Commit messages end with: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Current phase

See `docs/STATUS.md` for the live state and `docs/ROADMAP.md` §3 for what comes next. P0, P2, P3 and
P4 are complete (2026-09-18), and so are the modulation UI (M13), the layer/clip editing gaps
(M7, M9, M29), stems end to end (M5, M27, M28), autosave with crash recovery (M1) and **P6, lyrics**
(M18–M20, M26; 2026-09-25), **P7, the auto-director** (M21, M22) and **operability** (M33, M34,
M36) and **the P1 remainder** (extras tier, offline rebuild check; 2026-09-25) — every must-have is
done. P8, the Should-haves, is complete (ROADMAP §3 item 9): keyframes (S1), Shadertoy shaders
(S2), the 6-stem model (S6), masking (S7), markers (S9), motion blur (S10), LUTs (S11), the
performance HUD (S12), batch mode (S13), karaoke export (S15), draft mode (S18), Unicode text (S17) and beat refinement (S16) are all done, and MilkDrop is in
through Butterchurn (STATUS 4.83). ROADMAP §6 lists what is left. `npm run test` writes `out/vitest-last.json`: read it when a run fails.

- The smoke check's renderer code is one template literal: never write a backslash in it (`\n`
  becomes a real line break, `\b` a backspace). Delete `out/smoke-result.json` before a run: a run
  that dies leaves the old one behind.
- The end goal is a clean public repo: `Pulseforge.cmd` starts everything from nothing, and the app
  offers components (`setup/components.ts`). Nothing may assume the owner's PC, path or tools.
- `npm run dist` builds the installer. Anything the app writes goes under `DATA_ROOT`, never `ROOT`: installed, `ROOT` is
  the program and an update replaces it (`setup/lib/paths.ts`).

- MilkDrop is in, the director uses it (`src/director/milkdrop-catalogue.ts` is generated: `npm run
  milkdrop:measure -- --write`), and video exports on the CPU where NVENC will not open (STATUS 4.84, 4.85).
  Tests needing NVENC or CUDA skip where the machine cannot run them, so read the skip count.

The owner has asked for autonomous progress through the milestones, with `docs/STATUS.md` kept
detailed enough that a fresh session can take over mid-project. Commit at the end of each step.

- Edit files with the Edit/Write tools, never PowerShell text replacement (PowerShell 5.1
  re-encodes UTF-8 and corrupts the docs' punctuation).

## The macOS branch

`macos` is an orphan branch (no shared history with `main`, on purpose) for Apple Silicon. It stays runnable on Windows:
platform differences go through `setup/lib/platform.ts`. Its DMG is built by `.github/workflows/macos.yml`; nothing
here can run macOS; its packaged-app step is the real test of the DMG. Versions are `1.1.2-mac.N`, tags `v1.1.2-mac.N`.
STATUS 4.94 and 4.95 have the details. Port fixes between the branches by hand (cherry-pick does not apply).

## Development split

Specs were written on a non-NVIDIA laptop; this repo is built and run on the RTX machine, so GPU
checks can be run directly here. Shader code that compiles on Intel can fail on NVIDIA — target
WebGL2/GLSL ES 3.00 strictly, no vendor extensions (the Khronos `EXT_color_buffer_float` is
required and probed at startup), and surface compile errors with the source line rather than
failing to a black layer.

Vendored binaries (`vendor/ffmpeg`, `vendor/python`) are always invoked by absolute path. This
machine also has a system-wide Python and FFmpeg on `PATH` — never let those be picked up.
