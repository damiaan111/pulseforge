# Pulseforge — context for Claude Code

Self-hosted, GPU-accelerated audio visualizer and music-video renderer. Electron + TypeScript +
WebGL2, with a Python ML sidecar (Demucs, WhisperX) and FFmpeg/NVENC export.

**The planning phase is complete. Everything is specified. Read before writing code.**

## Read these first

| Order | Document | What it gives you |
|---|---|---|
| 1 | `PROJECT.md` | Vision, locked decisions, hardware envelope, architecture, all 40 must-haves, milestones, risks |
| 2 | `docs/decisions.md` | **Authoritative.** 47 resolved decisions. Where a spec's "open questions" disagrees, this wins |
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

## Current phase: P0

See `START-HERE.md`. Build the spike and the validation script — no UI, no app shell beyond what
the spike needs. P0 exists to replace the estimates in `PROJECT.md` §4 with measured numbers.

## Development split

Specs were written on a non-NVIDIA laptop; this repo is built and run on the RTX machine, so GPU
checks can be run directly here. Shader code that compiles on Intel can fail on NVIDIA — target
WebGL2/GLSL ES 3.00 strictly, no vendor extensions (the Khronos `EXT_color_buffer_float` is
required and probed at startup), and surface compile errors with the source line rather than
failing to a black layer.

Vendored binaries (`vendor/ffmpeg`, `vendor/python`) are always invoked by absolute path. This
machine also has a system-wide Python and FFmpeg on `PATH` — never let those be picked up.
