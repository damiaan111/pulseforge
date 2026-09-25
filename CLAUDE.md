# Pulseforge — context for Claude Code

Self-hosted, GPU-accelerated audio visualizer and music-video renderer. Electron + TypeScript +
WebGL2, with a Python ML sidecar (Demucs, WhisperX) and FFmpeg/NVENC export.

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
done; the next item is P8, the Should-haves (ROADMAP §3 item 9). `START-HERE.md` describes P0, which
is done.

The owner has asked for autonomous progress through the milestones, with `docs/STATUS.md` kept
detailed enough that a fresh session can take over mid-project. Commit at the end of each step.

- Edit files with the Edit/Write tools, never PowerShell text replacement (PowerShell 5.1
  re-encodes UTF-8 and corrupts the docs' punctuation).

## Development split

Specs were written on a non-NVIDIA laptop; this repo is built and run on the RTX machine, so GPU
checks can be run directly here. Shader code that compiles on Intel can fail on NVIDIA — target
WebGL2/GLSL ES 3.00 strictly, no vendor extensions (the Khronos `EXT_color_buffer_float` is
required and probed at startup), and surface compile errors with the source line rather than
failing to a black layer.

Vendored binaries (`vendor/ffmpeg`, `vendor/python`) are always invoked by absolute path. This
machine also has a system-wide Python and FFmpeg on `PATH` — never let those be picked up.
