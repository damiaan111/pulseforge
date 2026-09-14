# Build status — handoff document

> **Read this first in any new session.** It records what exists, what does not, how it works,
> how to verify it, and what to do next. Update it at the end of every step, in the same commit.
> Last updated: 2026-09-14 — end of P0 step 4 (export pipe), D39 resolved, D50 added.

---

## 1. Where we are

| Milestone | State |
|---|---|
| Planning (PROJECT.md, docs/*-spec.md, decisions D1–D50) | ✅ complete |
| **P0 — Spike** | 🔶 steps 1–4 done; **step 5 (`npm run validate`) next** |
| P1 — Provisioning | 🔶 core + stems tiers work (built in P0 step 2); lyrics/extras tiers and the offline CI job not started |
| P2 … P8 | ⬜ not started |

P0 steps (START-HERE.md):

| # | Step | State | Commit |
|---|---|---|---|
| 1 | Scaffolding + engine boundary lint | ✅ | `2152b91` |
| 2 | `npm run setup` provisioning | ✅ run on the RTX machine, `--verify` green | `2152b91` |
| 3 | Minimal deterministic engine + GPU determinism spike | ✅ byte-identical at 1080p and 4K | `0a0f2ba` |
| — | D48/D49 recorded, this document added | ✅ | `8d00833` |
| 4 | Frame pump, readback, GPU NV12, NVENC export + audio mux, verification, render report | ✅ | (this commit) |
| 5 | `npm run validate` (export-spec §17, eight checks → one pasteable report) | ⬜ next | |

---

## 2. Environment (the RTX machine)

- Repo: `D:\pulseforge` (must stay on D:, C: has ~19 GB free). Git branch `main`, no remote.
- Hardware: Ryzen 7 3800X, RTX 3060 12 GB, driver 616.92, Windows 11.
- Node 24.19 (system install). Setup and spike orchestrators run TypeScript directly via Node type stripping; Electron-side code is bundled with esbuild.
- System-wide Python 3.11 and `C:\ffmpeg` exist on PATH — **never use them**; everything goes through
  `vendor/` by absolute path (`setup/lib/paths.ts`).
- Shell gotchas: do not edit files with PowerShell `Get-Content | -replace | Set-Content` (re-encodes UTF-8).
  In the Bash tool, avoid `cd` (it moves the session's working directory); use absolute paths.
  1×1 `crop` fails on 4:2:0 video in FFmpeg — crop at least 2×2.

---

## 3. Commands

| Command | What it does | Needs |
|---|---|---|
| `npm install` | dev dependencies (TypeScript 6.0, ESLint 10, Vitest 5, Electron 44.3.0, esbuild 0.28.2) | network once |
| `npm run check` | typecheck + lint + all tests (103 at end of step 4; NVENC/FFmpeg tests skip without `vendor/`) | nothing |
| `npm run setup` | provision `vendor/` (core + stems); `--plan`, `--verify`, `--relock`, `--from <dir>`, `--tier core,stems` | network for first run |
| `npm run spike:determinism` | GPU determinism proof (2 processes × sequential / shuffled / undithered); `--4k`, `--seconds N`, `--audio <file>` | Electron, GPU |
| `npm run spike:export` | real export twice, compares raw frames + MP4 bytes, verifies, prints timings + encoder capability table; `--4k`, `--seconds N`, `--codec h264\|hevc`, `--conversion gpu-nv12\|swscale`, `--readback sync\|async`, `--depth N`, `--no-hash`, `--runs N`, `--audio <file>` | Electron, GPU, `vendor/ffmpeg` |

Outputs land in `out/spike/` (gitignored): stills, `export/export-run*.mp4`, `*.report.json`.

---

## 4. What exists, by area

### 4.1 Tooling
- TypeScript strict + `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `.ts` import extensions.
- ESLint engine boundary on `src/engine/**` (Electron/React/Node built-ins, shell/ui/export/ml imports,
  dynamic import, Date/performance/timers/rAF, DOM globals incl. `globalThis`, fetch/crypto, live audio,
  Math.random). Proven by `tests/lint/engine-boundary.test.ts`. Named exports only.
- Stay on TypeScript `~6.0.3` until typescript-eslint supports 7.

### 4.2 Provisioning (`setup/`) — unchanged since step 2
- Pins in `setup/manifest.ts`: FFmpeg n8.1.2 LGPL (BtbN autobuild-2026-09-14-13-17), python-build-standalone
  3.11.16+20260901, uv 0.12.13, htdemucs weights (full SHA-256 pinned).
- `setup/python/requirements.lock.txt` (committed): torch 2.13.0+cu130, demucs 4.1.0, numpy (explicit).
- Flow, isolation and offline Demucs loading as described in the step-2 commit; `vendor/` is 8.2 GB.

### 4.3 Engine (`src/engine/`)
| File | Contents |
|---|---|
| `core/time.ts` | Rational fps, 48 kHz ticks, `frameCount` (BigInt-exact), `frameTimeSeconds`, `frameStartTick` (floor), `timelineToSourceSeconds` |
| `core/prng.ts` | keyed `hash32`/`random01`/`createPrng` + bit-identical `HASH_GLSL`; outputs pinned by snapshot |
| `core/color.ts` | sRGB/linear/BT.709 transfer, hex parsing, premultiply, hue-preserving tone shoulder (`TONEMAP_KNEE = 0.9`, D48) + `COLOR_GLSL` |
| `core/params.ts` | P0 param schema subset + `resolveParams` (defaults → clamp → coerce; unknown keys preserved/reported) |
| `core/analysis.ts` | `AnalysisTrack`/`AnalysisSet`, linear-interp clamped sampling |
| `core/module.ts`, `core/project.ts` | module manifest + render contract; `RenderProject` P0 snapshot (seed, canvas, audio placement, layers) |
| `render/gl.ts` | context requirements (EXT_color_buffer_float), shader compile errors with source lines, fullscreen triangle |
| `render/targets.ts` | pooled `rgba16f` / `rgba8` / `rgb10a2` targets |
| `render/compositor.ts` | linear premultiplied compositing (normal/add/screen), output pass: tonemap → sRGB/BT.709 OETF → seeded TPDF dither (scaled to 8 or 10 bits) → RGBA8 or RGB10_A2, optional Y flip |
| `render/yuv.ts` | **GPU BT.709 limited-range NV12**, packed into RGBA8 targets (Y: w/4×h, UV: w/4×h/2) so readback uses only RGBA/UNSIGNED_BYTE; needs width % 4 == 0 |
| `render/readback.ts` | `AsyncReadback` PBO ring (readPixels→PIXEL_PACK_BUFFER, fenceSync, non-blocking poll, getBufferSubData); `readSync`; 10-bit via UNSIGNED_INT_2_10_10_10_REV |
| `modules/bars.ts` | `core.visualizer.bars` v0.1.0 |
| `engine.ts` | `createEngine(gl, {quality, output: {transfer, dither, flipY, bitDepth}, packing: 'rgba'\|'nv12'})`; `renderFrame(project, analysis, frameIndex)`; `readOutputSync`; `createSyncReadback` / `createReadback(depth)` (same `FrameReadback` interface); 10-bit read format probed at creation; `ENGINE_VERSION = '0.1.0-p0'` |

### 4.4 Analysis (`src/analysis/`) — unchanged since step 3
- FFT 2048 → 64 log bins (30 Hz–16 kHz) + `bass` band at 240 Hz, dBFS-mapped 0..1; `ANALYSIS_VERSION = 1`.
- `decodeMono48k` via vendored FFmpeg with PCM SHA-256.
- Not yet: onsets, BPM/beat grid, RMS/peak/centroid/flux, stems analysis, on-disk AnalysisCache, workers.

### 4.5 Export (`src/export/`) — new in step 4
| File | Contents |
|---|---|
| `ffmpeg-args.ts` | `EncodeSettings` (codec, bitDepth, chroma, preset, cq, conversion `gpu-nv12`\|`swscale`, audio kbps), D40 defaults (H.264 8-bit CQ 17 **gpu-nv12**; HEVC 10-bit CQ 19 swscale), `settingsProblems`, `resolveConversion` (falls back to swscale when NV12 impossible), `buildFfmpegArgs` (rawvideo stdin, `-progress pipe:1`, `setparams` colour stamping, NVENC p5/tune hq/vbr/cq/lookahead 32/bf 3/GOP 2 s, all four BT.709 tags, `hvc1` for HEVC, AAC 320k, bit-exact flags, faststart), `formatCommandLine` |
| `pump.ts` | `pumpFrames`: render → readback submit → FIFO collect → `onFrame` (hash) → sink write; bounded buffer pool (`depth + maxQueuedWrites`) gives backpressure; cancel; per-stage timing stats. No GL/Node types (unit-tested with fakes) |
| `encoder.ts` | `startEncoder`: FFmpeg child, stdin sink that resolves on write callback, encoder-side frame count from `-progress`, `diagnoseEncoderFailure` (NVENC unavailable, unknown encoder, disk full, pixel format, permissions) |
| `audio.ts` | `samplesForFrames` (exact rational), `placeAudio` (clip-in/out, lead-in, pad/cut to video length, reports adjustment), `encodeWavFloat32`, `decodeStereo48k`, `prepareExportAudio` |
| `verify.ts` | `probeFile` (ffprobe `-count_packets`), `checkOutput`: exact frame count, size, rate, codec, pix_fmt (swscale), all four colour tags, audio within one frame |
| `encoder-probe.ts` | `probeEncoders`: actually opens each NVENC variant (H.264 8-bit 420/444, HEVC 8/10-bit 420/444, AV1) on a 320×240 clip |
| `report.ts` | `RenderReport` v1 type (output hash, project hash, settings, command line, readback mode/depth, audio adjustment, timings, GPU, verification, warnings) |
| `job.ts` | `runExport(request)`: settings → frame count → audio prep → args → engine (quality forced `final`, D20; sRGB, D49; packing from conversion) → sync/async readback → pump → encoder finish → ffprobe verify → report JSON at `<output>.report.json`; deletes partial output on failure unless `keepPartial` |

### 4.6 Spike harness (`spike/`)
- `harness.ts`: esbuild bundling of `spike/electron/{main,renderer}.ts` into `out/spike/`, `runElectron` (config via env var, `PROGRESS` lines relayed), helpers.
- `electron/main.ts`: hidden window, `--use-angle=d3d11`, `nodeIntegration` renderer (spike-grade security).
- `electron/renderer.ts`: `determinism` mode (step 3 passes) and `export` mode (calls `runExport`, yields via MessageChannel).
- `determinism.ts`, `export.ts`: orchestrators; `test-signal.ts` synthetic track; `analysis-file.ts` spike-only analysis hand-off; `project.ts` the P0 bars project.

---

## 5. Measured results (RTX 3060, driver 616.92, ANGLE D3D11, Electron 44.3.0 / Chrome 152)

### Determinism
| What | Result |
|---|---|
| Engine, 1080p60 600 frames, 4K60 300 frames | byte-identical across 2 processes × (sequential, shuffled on fresh context, undithered) |
| Export raw frames (RGBA and NV12, 8- and 10-bit) | identical across 2 export runs |
| Export MP4 files with bit-exact muxing (H.264 and HEVC 10-bit) | **byte-identical across runs** — file-level hashes are usable (decisions §10 item 6 answered) |

### Export throughput (synthetic bars project, 5–10 s, no frame hashing unless noted)
| Path | 1080p60 | 4K60 |
|---|---|---|
| async PBO ring depth 3, RGBA, swscale | 77 fps | 22 fps |
| async PBO depth 1 / 6 | 78 / 76 fps | 23 / 22 fps |
| sync readPixels, RGBA, swscale | 104 fps | 28 fps |
| sync, RGBA handed to NVENC (no swscale) | 104 fps | 27 fps — and mis-tagged full range → rejected |
| **sync, GPU NV12 (default for H.264)** | **198 fps (3.3× realtime)** | **57 fps (0.95× realtime)** |
| HEVC 10-bit, async depth 3, swscale, with hashing | 58 fps | not measured |

Per-frame costs at 4K isolated with FFmpeg alone: swscale ~3 ms, NVENC encode ~11 ms (p5, lookahead 32),
RGBA through a pipe ~20 ms. With GPU NV12 the 4K limit is NVENC. Frame hashing (SHA-256) costs ~4 ms at
1080p RGBA and ~16 ms at 4K RGBA.

### Colour
- GPU NV12 vs swscale exports of the same frames: PSNR 64 dB (Y 72 dB), SSIM 0.99994; decoded pixels identical.
- Fill `#ff2d95` decodes as (250, 42, 145); background `#0b0614` as (11, 4, 20). The fill's 255 red channel is
  1.0 linear, above the D48 knee (0.9), so the tone shoulder compresses it slightly; the background's green
  shift is 4:2:0 chroma + 8-bit round trip. See §7.

### Encoder capabilities (probe)
H.264 8-bit 4:2:0 ✔ · H.264 8-bit 4:4:4 ✔ · HEVC 8-bit 4:2:0 ✔ · HEVC 10-bit 4:2:0 ✔ · HEVC 8-bit 4:4:4 ✔ ·
HEVC 10-bit 4:4:4 ✔ · AV1 ✖ (Ampere, as expected).

### Other
- Analysis of 10 s audio: ~150 ms single-threaded. torch 2.13.0+cu130 sees the RTX 3060.
- Not yet measured: Demucs wall time/VRAM, A/V click-track sync, ramp colour round trip, full encoder
  preset matrix, representative (multi-layer) project throughput. All are `npm run validate` items.

---

## 6. Decisions made during implementation

- **D48** tone curve = hue-preserving highlight shoulder, knee 0.9 (owner confirmed).
- **D49** output transfer = sRGB OETF for preview and export, files tagged BT.709 (owner confirmed).
- **D39 resolved** by measurement: GPU NV12 for 8-bit 4:2:0 exports; swscale for 10-bit/4:4:4.
- **D50** synchronous readback by default; PBO ring kept as an option (slower through ANGLE).
- uv has no download command → pip downloads the wheelhouse (PROJECT.md §3).
- torch pinned to CUDA 13.0 wheels (`cu130`), driver R580+.
- Spectrum bins use the peak FFT bin in range (engine-local, easy to change).
- FFmpeg 8 drops `-color_trc`/`-color_primaries` for filtered frames → colour tags are stamped with `setparams` in the filter chain.

---

## 7. Known gaps, debts and open questions

- **Tone shoulder touches fully saturated authored colours.** With knee 0.9, any channel at 255 (1.0 linear) is
  compressed to ~250. D48 says "below the knee is untouched", which is true, but pure palette primaries sit above
  it. Options if the owner objects: raise the knee to 1.0 with the roll-off only above 1.0 (needs headroom above
  white, i.e. compress from (1, ∞) into (0.97, 1]), or accept. Not changed without the owner.
- `RenderProject` is a P0 subset; no real document schema, migrations or undo (`src/project/`).
- One module (bars). No effects, masks, groups, text, palette roles, aspect overrides, modulation.
- `quality: 'preview'` is plumbed but unused.
- Async PBO readback is not implemented for NV12 packing (sync only, by measurement).
- The spike renderer uses `nodeIntegration` + `contextIsolation: false`; the app shell must decide how the
  export process gets Node access (utility process + shared memory, or a dedicated export window).
- Audio stream-copy when untouched (export-spec §7) not implemented — always AAC 320k.
- No render queue, pause/resume, disk-space precheck, live thumbnail, motion blur, SSAA (export-spec §9, §12–14).
- Unknown modules warn instead of rendering the visible placeholder module-spec §9 asks for.
- Frame hashing runs on the render thread; move to a worker if it is kept on for long exports.

---

## 8. Next step (P0 step 5) — `npm run validate`

The eight checks of export-spec §17, one pasteable report, reusing what exists:

1. **Environment** — GPU/driver (`nvidia-smi`), CUDA/torch (vendored Python probe), FFmpeg build, WebGL2
   renderer/limits/extensions, ANGLE backend, PCIe link (`nvidia-smi -q`).
2. **Determinism** — reuse `spike/determinism.ts` logic (raw frames) + export MP4 hash comparison.
3. **Readback benchmark** — sync vs async depths 1–4 at 1080p/4K, RGBA and NV12 (the matrix in §5 above).
4. **Colour correctness** — render a known ramp/patch project, export via gpu-nv12 and swscale (+ HEVC 10-bit),
   decode, compare against expected BT.709 limited-range values; check tags.
5. **Encoder matrix** — H.264/HEVC × 420/444 × p1/p5/p7 at 1080p/4K: encode fps + size (FFmpeg lavfi source,
   `encoder-probe.ts` style).
6. **Throughput** — 60 s at 1080p60 and 4K60 on a representative project (needs a heavier test project than one
   bars layer: several bars layers with add/screen blends as a stand-in until more modules exist).
7. **Stems** — Demucs `htdemucs` (and `htdemucs_ft`, which setup does not fetch yet — fetch on demand or report
   "not installed") on a 4-minute track: wall time + peak VRAM via `torch.cuda.max_memory_allocated`.
   Needs a minimal sidecar script in `python/pulseforge_ml/`.
8. **Sync** — click-track project (a visual impulse on each click via a band/onset-driven parameter), export,
   decode, find the frame where luminance jumps vs the audio transient sample; must be within one frame.

Then: paste the report into STATUS.md §5, replace PROJECT.md §4 estimates, revisit D40 with the encoder matrix,
mark P0 done, and start P1/P2.
