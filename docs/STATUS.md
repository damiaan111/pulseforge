# Build status — handoff document

> **Read this first in any new session.** It records what exists, what does not, how it works,
> how to verify it, and what to do next. Update it at the end of every step, in the same commit.
> Last updated: 2026-09-14 — end of P0 step 3, decisions D48–D49 recorded.

---

## 1. Where we are

| Milestone | State |
|---|---|
| Planning (PROJECT.md, docs/*-spec.md, decisions D1–D49) | ✅ complete |
| **P0 — Spike** | 🔶 in progress: steps 1–3 done, step 4 (export pipe) next, then step 5 (`npm run validate`) |
| P1 — Provisioning | 🔶 core + stems tiers already work (built in P0 step 2); lyrics/extras tiers, offline CI job not started |
| P2 … P8 | ⬜ not started |

P0 steps (from START-HERE.md):

| # | Step | State | Commit |
|---|---|---|---|
| 1 | Scaffolding + engine boundary lint | ✅ | `2152b91` |
| 2 | `npm run setup` provisioning | ✅ run on the RTX machine, `--verify` green | `2152b91` |
| 3 | Minimal deterministic engine + GPU determinism spike | ✅ byte-identical at 1080p and 4K | `0a0f2ba` |
| 4 | Offline frame pump, async PBO readback, NVENC export + audio mux | ⬜ next | |
| 5 | `npm run validate` (export-spec §17, eight checks) | ⬜ | |

---

## 2. Environment (the RTX machine)

- Repo: `D:\pulseforge` (must stay on D:, C: has ~19 GB free). Git branch `main`, no remote.
- Hardware: Ryzen 7 3800X, RTX 3060 12 GB, driver 616.92, Windows 11.
- Node 24.19 (system install). Setup and scripts run TypeScript directly via Node type stripping.
- System-wide Python 3.11 and `C:\ffmpeg` exist on PATH — **never use them**; everything goes through
  `vendor/` by absolute path (`setup/lib/paths.ts`).
- Shell gotcha: do not edit files with PowerShell `Get-Content | -replace | Set-Content` (re-encodes
  UTF-8, corrupts `§`/`—`). Use editor tools.

---

## 3. Commands

| Command | What it does | Needs |
|---|---|---|
| `npm install` | dev dependencies (TypeScript 6.0, ESLint 10, Vitest 5, Electron 44.3.0, esbuild 0.28.2) | network once |
| `npm run check` | typecheck + lint + all unit tests (80 at end of step 3) | nothing |
| `npm run setup` | provision `vendor/` (core + stems); `--plan`, `--verify`, `--relock`, `--from <dir>`, `--tier core,stems` | network for first run |
| `npm run setup -- --verify` | offline re-check of every artefact + wheelhouse + CUDA + htdemucs load | `vendor/` |
| `npm run spike:determinism` | GPU determinism proof; `--4k`, `--seconds N`, `--audio <file>` | Electron, GPU; `vendor/ffmpeg` for PNG stills / `--audio` |

---

## 4. What exists, by area

### 4.1 Tooling (`package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`)
- TypeScript strict + `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `.ts` import extensions
  (so Node can run sources directly and esbuild can bundle them).
- ESLint engine boundary on `src/engine/**`: bans Electron/React/Node built-ins, imports from
  shell/ui/export/ml, dynamic `import()`, `Date`/`performance`/timers/rAF, DOM globals incl.
  `globalThis`, `fetch`/`crypto`, live audio nodes, `Math.random`. Proven by
  `tests/lint/engine-boundary.test.ts`. Named exports only everywhere (config files exempt).
- TypeScript 7 exists but typescript-eslint supports ≤ 6.0; stay on `~6.0.3` until that changes.

### 4.2 Provisioning (`setup/`)
- `setup/manifest.ts` pins: FFmpeg n8.1.2 LGPL (BtbN autobuild-2026-09-14-13-17), python-build-standalone
  3.11.16+20260901, uv 0.12.13, htdemucs weights (full SHA-256 pinned after first verified download).
- `setup/python/requirements.in` → committed `requirements.lock.txt` (uv compile, hashes, wheels only):
  torch 2.13.0+cu130, demucs 4.1.0, numpy (explicit: demucs 4.1.0 only declares it for macOS x86).
- Flow: preflight → FFmpeg → Python → uv → lock → `pip download --require-hashes` into
  `vendor/wheelhouse/` → `uv pip install --offline --no-index` → health probe (CUDA visible, demucs
  imports, isolation) → htdemucs weights + offline load test → `vendor/vendor.lock.json` +
  `vendor/LICENSES.md`.
- Isolation from system Python: `setup/lib/env.ts` strips PYTHON*/PIP_*/UV_* and sets
  `PYTHONNOUSERSITE=1`; temp/caches under `vendor/`.
- Demucs loads offline via `get_model('htdemucs', repo=Path('vendor/models/demucs'))`
  (needs `htdemucs.yaml` + `955717e8-8726e21a.th` there; setup puts both).
- Deviation recorded in PROJECT.md §3: uv has no `pip download`; pip downloads, uv resolves/installs.
- `vendor/` measured at 8.2 GB (core + stems).

### 4.3 Engine (`src/engine/`)
| File | Contents |
|---|---|
| `core/time.ts` | `Rational` fps, `TICKS_PER_SECOND = 48000`, `frameCount` (BigInt-exact ceil), `frameTimeSeconds(n, fps)`, `frameStartTick` (floor for NTSC), `timelineToSourceSeconds` (the single timeline→audio mapping) |
| `core/prng.ts` | `hash32(seed, ...keys)`, `random01`, `createPrng`; Murmur3 finaliser + FNV mixing, integer-only; `HASH_GLSL` bit-identical GLSL twin. **Output values pinned by snapshot** (`tests/engine/__snapshots__`) — changing them changes every project |
| `core/color.ts` | sRGB/linear/BT.709 transfer functions, hex parsing, premultiply; `tonemap` = hue-preserving shoulder, `TONEMAP_KNEE = 0.9` (D48); `COLOR_GLSL` twin |
| `core/params.ts` | Param schema subset (float/int/bool/enum/color/select:stem), `resolveParams` (defaults → clamp → coerce; unknown keys preserved + reported; wrong types reported) |
| `core/analysis.ts` | `AnalysisTrack` (rate, channels, interleaved Float32), `AnalysisSet` per stem, `sampleTrack`/`sampleTrackInto` (linear interp, clamped) |
| `core/module.ts` | `ModuleManifest`, `RenderContext` (time, canvas, analysis, audioSeconds, prng, gl, quality, warn), `ModuleInstance`, `ModuleDefinition` |
| `core/project.ts` | `RenderProject` — P0 snapshot subset: seed, canvas {w,h,fps,background}, audio {leadInTicks, clipInTicks}, layers {id, module, enabled, opacity, blend, params} |
| `render/gl.ts` | `requireContextFeatures` (EXT_color_buffer_float or throw), `createProgram` with `formatShaderLog` (source line context), fullscreen triangle |
| `render/targets.ts` | `TargetPool` of `rgba16f`/`rgba8` framebuffers, high-water mark |
| `render/compositor.ts` | Layers into RGBA16F, premultiplied blend (normal/add/screen) into composite, output pass: tonemap → sRGB or BT.709 OETF → seeded TPDF dither → RGBA8, optional Y flip (top-down rows for video). GL state reset before every pass |
| `modules/bars.ts` | `core.visualizer.bars` v0.1.0: source stem, barCount, barWidth, spread, baseline, min/maxHeight, fill; instanced quads with analytic AA; `binsToBars` |
| `engine.ts` | `createEngine(gl, {quality, output})` → `renderFrame(project, analysis, frameIndex)` returns `FrameReport` (warnings, param issues); `readOutputSync(Uint8Array)`; unknown modules reported, not rendered |

### 4.4 Analysis (`src/analysis/`)
- `fft.ts`: radix-2 in-place FFT, periodic Hann.
- `spectrum.ts`: `computeSourceAnalysis(pcm48kMono)` → 64 log bins (30 Hz–16 kHz, peak per bin,
  interpolated below one FFT bin) + `bass` band (40–160 Hz, power sum); FFT 2048, 240 Hz hop of 200
  samples; levels = sine-equivalent dBFS mapped −72..0 dB → 0..1. `ANALYSIS_VERSION = 1`.
- `decode.ts`: `decodeMono48k(ffmpegExe, file)` → Float32 PCM + SHA-256 of decoded PCM.
- Not yet: onsets, BPM/beat grid, RMS/peak/centroid/flux tracks, stems analysis, on-disk AnalysisCache
  format (data-formats §4), workers.

### 4.5 Spike harness (`spike/`)
- `determinism.ts` (orchestrator, Node) → bundles `spike/electron/{main,renderer}.ts` with esbuild into
  `out/spike/`, computes analysis, runs Electron twice.
- Electron main: hidden window, `--use-angle=d3d11`, `nodeIntegration` renderer (spike only).
- Renderer: pass A sequential, pass B scrambled on a fresh WebGL2 context, pass C undithered;
  SHA-256 of every frame; raw frames → PNG via vendored FFmpeg.
- `test-signal.ts`: deterministic synthetic track (kick, bass, chord, sweep, seeded hats).
- `analysis-file.ts`: spike-only binary hand-off format (not the real cache format).

---

## 5. Measured results so far (RTX 3060, ANGLE D3D11, Electron 44.3.0 / Chrome 152)

| What | Result |
|---|---|
| Determinism, 1080p60, 600 frames | all passes byte-identical across 2 processes (combined hash `7d5159cf…` with sRGB OETF per D49) |
| Determinism, 4K60, 300 frames | byte-identical |
| Sync readback (`readPixels`, includes GPU wait) | ~4.0 ms/frame 1080p, ~15 ms/frame 4K (render call itself ~0.1 ms because GL is async) |
| Analysis of 10 s audio | ~150 ms (single thread) |
| torch CUDA | 2.13.0+cu130 sees the RTX 3060 (CUDA 13.0) |

Not yet measured: async PBO readback, NVENC encode speed, end-to-end export fps, Demucs wall time /
VRAM, colour round trip, A/V sync.

---

## 6. Decisions made during implementation (all recorded in docs/decisions.md or PROJECT.md)

- **D48** tone curve = hue-preserving highlight shoulder, knee 0.9 (owner confirmed).
- **D49** output transfer = sRGB OETF for preview and export, files tagged BT.709 (owner confirmed).
- uv has no download command → pip downloads the wheelhouse (PROJECT.md §3).
- torch pinned to CUDA 13.0 wheels (`cu130`), driver R580+ required (preflight checks).
- Spectrum bins use the peak FFT bin in range, not the average (engine-local choice; easy to change).
- Readback in the spike is synchronous; async PBOs are step 4.

---

## 7. Known gaps / debts (not bugs, but not done)

- `RenderProject` is a P0 subset; the real document schema, migrations and undo (`src/project/`) do not exist.
- Only one module (bars). No effects, masks, groups, text, palette roles, aspect overrides, modulation.
- `quality: 'preview'` is plumbed but unused.
- Compositor output target is 8-bit only; 10-bit (RGB10_A2 → x2bgr10le/p010) for the HEVC master is step 4 work.
- Unknown modules produce a warning, not the visible placeholder module-spec §9 asks for.
- Spike renderer uses `nodeIntegration` + `contextIsolation: false`; acceptable for the spike only.
- No render reports, no queue, no UI, no preview clock.

---

## 8. Next step (P0 step 4) — plan

1. `src/engine/render/readback.ts`: async PBO ring (`readPixels` into `PIXEL_PACK_BUFFER`,
   `fenceSync`, poll `clientWaitSync(…, 0)`, `getBufferSubData`), non-blocking API; 8- and 10-bit.
2. Compositor 10-bit output target (`RGB10_A2`), dither scaled to the output depth.
3. `src/export/`: FFmpeg argument builder (unit-tested), encoder capability probe, audio preparation
   (trim/lead-in/pad to exactly N/fps worth of samples), frame pump with bounded buffer pool and
   stdin backpressure, ffprobe verification, render report JSON.
4. `npm run spike:export`: renders the spike project to MP4 via NVENC twice, compares raw-frame hashes
   and bit-exact file hashes, verifies frame count/tags/durations, reports timings.
