# Build status — handoff document

> **Read this first in any new session.** It records what exists, what does not, how it works,
> how to verify it, and what to do next. Update it at the end of every step, in the same commit.
> Last updated: 2026-09-14 — P0 complete; **P2 steps 1–3 (document, layout, modulation) done**.

---

## 1. Where we are

| Milestone | State |
|---|---|
| Planning (PROJECT.md, docs/*-spec.md, decisions D1–D50) | ✅ complete |
| **P0 — Spike** | ✅ **complete** — `npm run validate` passes 8/8; measurements in PROJECT.md §4 and `docs/validation/p0-full-report.md` |
| P1 — Provisioning | 🔶 core + stems tiers work; lyrics/extras tiers, `htdemucs_ft`, offline-rebuild CI job not started |
| **P2 — Engine** | 🔶 **in progress** — steps 1–3 of 6 done (see §8) |
| P3 … P8 | ⬜ not started |

P2 steps:

| # | Step | State | Commit |
|---|---|---|---|
| 1 | Project document v1: schema, parse, migrate, serialise, `toRenderProject` | ✅ | `ce8b68f` |
| 2 | Layout & aspect system | ✅ | `830bea9` |
| 3 | Param resolution + modulation evaluator | ✅ | `91c18db` |
| 4 | Effect chain contract + bloom/vignette | ⬜ | |
| 5 | Golden frames | ⬜ | |
| 6 | Headless render CLI | ⬜ | |

P0 steps:

| # | Step | State | Commit |
|---|---|---|---|
| 1 | Scaffolding + engine boundary lint | ✅ | `2152b91` |
| 2 | `npm run setup` provisioning | ✅ | `2152b91` |
| 3 | Deterministic engine + GPU determinism spike | ✅ | `0a0f2ba` |
| — | D48/D49, this document | ✅ | `8d00833` |
| 4 | Export pipe: readback, GPU NV12, NVENC, audio mux, verify, report | ✅ | `56cf79a` |
| 5 | `npm run validate` + Python sidecar + test modules | ✅ 8/8 pass | `38d5362` |

**Starting a new session:** open Claude Code in `D:\pulseforge` and say: *"Read CLAUDE.md and docs/STATUS.md,
run `npm run check`, then continue with §8 (P2 step 4). Keep STATUS.md updated and commit after each step."*

---

## 2. Environment (the RTX machine)

- Repo: `D:\pulseforge` (must stay on D:, C: has ~19 GB free). Git branch `main`, no remote.
- Hardware: Ryzen 7 3800X (16 threads), 16 GB RAM, RTX 3060 12 GB, driver 616.92, PCIe Gen3 x16, Windows 11 (10.0.26200).
- Node 24.19. Node-side scripts run TypeScript directly (type stripping); Electron-side code is bundled with esbuild.
- System-wide Python 3.11 and `C:\ffmpeg` exist on PATH — **never use them**; everything goes through `vendor/` by absolute path.
- Shell gotchas: never edit files with PowerShell `Get-Content | -replace | Set-Content` (re-encodes UTF-8).
  In the Bash tool, avoid `cd` (it moves the session's working directory). FFmpeg `crop` needs ≥ 2×2 on 4:2:0.
- Do not run GPU work (spikes, validate) concurrently with benchmarks — it skews timings.

---

## 3. Commands

| Command | What it does | Time |
|---|---|---|
| `npm install` | dev deps (TypeScript 6.0, ESLint 10, Vitest 5, Electron 44.3.0, esbuild 0.28.2) | once |
| `npm run check` | typecheck + lint + 225 tests (FFmpeg/Python tests skip without `vendor/`; the GPU layout test skips without Electron) | ~10 s |
| `npm run setup` | provision `vendor/`; `--plan`, `--verify`, `--relock`, `--from <dir>`, `--tier` | first run ~10 min |
| `npm run validate` | the eight P0 checks → `out/validate/report.md` + `report.json`; `--quick` (~5 min), `--only 2,4,8` | ~11 min full |
| `npm run spike:determinism` | engine determinism on GPU; `--4k`, `--seconds N`, `--audio <file>` | ~30 s |
| `npm run spike:export` | real export ×2 with comparison + timings; `--4k`, `--seconds`, `--codec h264\|hevc`, `--conversion gpu-nv12\|swscale`, `--readback sync\|async`, `--depth`, `--no-hash`, `--runs`, `--audio` | ~1 min |

Outputs go to `out/` (gitignored). `--only` rewrites report.md with the other checks marked skipped.

---

## 4. What exists, by area

### 4.1 Tooling
- TypeScript strict + `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `.ts` import extensions.
- ESLint engine boundary on `src/engine/**` (proven by `tests/lint/engine-boundary.test.ts`); named exports only;
  `_`-prefixed unused names allowed. Stay on TypeScript `~6.0.3` until typescript-eslint supports 7.

### 4.2 Provisioning (`setup/`)
- Pins in `setup/manifest.ts`: FFmpeg n8.1.2 LGPL, python-build-standalone 3.11.16, uv 0.12.13, htdemucs weights.
- `setup/python/requirements.lock.txt`: torch 2.13.0+cu130, demucs 4.1.0, numpy (explicit — demucs omits it off macOS).
- Wheelhouse in `vendor/wheelhouse/`, offline install, isolation from system Python, `vendor.lock.json`, `LICENSES.md`.

### 4.3 Engine (`src/engine/`)
| File | Contents |
|---|---|
| `core/time.ts` | rational fps, 48 kHz ticks, `frameCount`, `frameTimeSeconds`, `frameStartTick`, `timelineToSourceSeconds` |
| `core/prng.ts` | keyed `hash32`/`random01`/`createPrng` + `HASH_GLSL` (outputs pinned by snapshot) |
| `core/color.ts` | transfer functions, hex, premultiply, D48 tone shoulder (`TONEMAP_KNEE = 0.9`) + `COLOR_GLSL` |
| `core/params.ts` | param schema + `resolveParams` (full module-spec §5 order: base → modulation → clamp → coerce) |
| `core/analysis.ts` | analysis tracks and sampling |
| `core/layout.ts` | anchors, scale references, layer transform matrix (§4.8) |
| `core/modulation.ts` | binding compilation, precomputed envelopes, signal chain, accumulation (§4.10) |
| `core/module.ts`, `core/project.ts` | module contract; `RenderProject` P0 snapshot |
| `render/gl.ts` | context requirements + `ContextInfo` (renderer, versions, limits, extensions), shader errors with source lines |
| `render/targets.ts` | pooled `rgba16f` / `rgba8` / `rgb10a2` targets |
| `render/compositor.ts` | linear premultiplied compositing (normal/add/screen) → tonemap → OETF → seeded dither (8/10-bit) → output |
| `render/yuv.ts` | GPU BT.709 limited-range NV12 packed into RGBA8 targets |
| `render/readback.ts` | async PBO ring + sync readback (8- and 10-bit) |
| `modules/bars.ts` | `core.visualizer.bars` |
| `modules/test-pattern.ts` | `core.test.pattern` — 24 fixed patches (`TEST_PATTERN_COLORS`) for colour measurement |
| `modules/flash.ts` | `core.test.flash` — full-frame flash on a timeline schedule (`flashLit`) for sync measurement |
| `engine.ts` | `createEngine(gl, {quality, output, packing})`, `renderFrame`, `readOutputSync`, `createSyncReadback`, `createReadback`; `ENGINE_VERSION = '0.1.0-p0'` |

### 4.4 Analysis (`src/analysis/`)
- FFT 2048 → 64 log bins + `bass` band at 240 Hz; `decodeMono48k` via vendored FFmpeg. `ANALYSIS_VERSION = 1`.
- Not yet: onsets, beat grid, RMS/peak/centroid/flux, stems analysis, on-disk AnalysisCache, workers.

### 4.5 Export (`src/export/`)
`ffmpeg-args.ts` (settings, D40 defaults, gpu-nv12/swscale, colour tags via `setparams`, bit-exact), `pump.ts`
(bounded pipeline), `encoder.ts` (FFmpeg process + diagnosis), `audio.ts` (exact placement), `verify.ts` (ffprobe
checks), `encoder-probe.ts`, `report.ts`, `job.ts` (`runExport`, optional `dither: false` for measurement).

### 4.6 ML sidecar
- `python/pulseforge_ml/` (`python -m pulseforge_ml`, cwd = `python/`): JSON lines on stdout
  (`progress` / `log` / `result` / `error`). Commands: `health` (python, torch, CUDA, cuDNN, demucs) and
  `separate` (raw float32 PCM in, htdemucs via `get_model(name, repo=vendor/models/demucs)`, per-segment
  progress from Demucs' callback, timings, peak VRAM, per-stem RMS, optional stem output files).
- `src/ml/sidecar.ts`: `runSidecar` (spawn, parse, progress callbacks, `SidecarError` with stderr tail), `parseSidecarLine`.
- Not yet: long-lived process, cancellation, supervisor/restart, GPU job queue (M27/M28), WhisperX.

### 4.7 Project document (`src/project/`) — P2 step 1
| File | Contents |
|---|---|
| `document.ts` | `ProjectDocument` v1 types: canvas, audio clip/placement, analysis settings, palette, layers (module + group, nesting per M38), transform, time range, effects, modulation bindings, per-aspect overrides. `CURRENT_SCHEMA_VERSION = 1`, `RESERVED_DOCUMENT_KEYS`, `walkLayers`, `aspectBucket` |
| `ids.ts` | ULID-style 26-char Crockford base32 ids, injectable clock/RNG, `createTestIdFactory` for fixtures |
| `parse.ts` | `parseDocument` → `{ document, issues }`. Refuses (throws) a non-object, a missing `schemaVersion` and a future version; everything else is a reported, repaired issue. Every node keeps an `extra` bag of undeclared fields |
| `migrate.ts` | ordered `v(n) → v(n+1)` chain, forward-compat refusal, missing-step refusal, `backupPathFor` (`song.v3.bak`). Empty at v1 by design |
| `serialize.ts` | stable key order, `extra` written back, trailing newline |
| `load.ts` | text → migrate → parse, reporting `migratedFrom` so the shell knows to back up |
| `create.ts` | `createDocument` / `createModuleLayer` / `createGroupLayer` / `createEffect` / `createBinding`, default bands, D8 stem model |
| `snapshot.ts` | `toRenderProject` (flattens groups, applies solo/disabled-parent, carries time ranges) + `timelineDurationTicks`. Returns **notes** naming everything the document asks for that the engine cannot render yet |

Engine side: `LayerSpec.timeRange` (optional) and `layerIsLive`; `renderFrame` skips layers outside
their range, using the frame's start tick.

Not yet: undo/commands, presets, asset library, lyrics/automation/export-preset slots (reserved,
round-tripped untouched).

### 4.8 Layout & aspect (P2 step 2)
- `src/engine/core/layout.ts`: `ANCHORS`, `SCALE_REFERENCES` (the single definition — `src/project/`
  re-exports them), `LayerTransform`, `referenceLength`, `anchorFraction`, affine `Mat3` helpers,
  `layerMatrix` (forward + inverse), `isIdentityTransform`.
- Matrix is built in **document space** (y down, positive rotation clockwise) as
  `translate(position) · rotate · skew · scale · translate(−anchor)`, then conjugated into the
  compositor's y-up space. Identity in → identity out, so an untransformed layer takes the exact
  1:1 `texelFetch` blit and its pixels are unchanged from P0.
- `isIdentityTransform` compares the position against the **anchor fraction**, not against 0.5:
  anchored top-left at (0.5, 0.5) is a real move. Getting this wrong makes the transform work
  everywhere except that combination.
- Compositor: `CompositeLayer.inverseTransform` (optional). When present the layer pass samples
  with the inverse matrix, bilinear, with an explicit bounds test — `CLAMP_TO_EDGE` alone smears
  border texels across the canvas. Pooled targets are set to `LINEAR` at sample time.
- `RenderContext.canvas.referenceScale` is **per layer**, from that layer's `scaleReference`, so a
  logo on `min` and a full-bleed background on `max` each get the number they need.
- A collapsed transform (zero scale) is reported as a warning and the layer is skipped, rather
  than dividing by a zero determinant.
- `toRenderProject` applies the aspect override (step 2 of module-spec §5): the override replaces
  only the properties it declares, both for `transform` and for `params`.
- Group transforms still do not compose onto children (M38, step 4 territory) — noted, not dropped.

Verified on the GPU by `tests/golden/layout-gpu.test.ts` (Electron + the new `frames` spike mode,
`spike/lib/frames-run.ts`): orientation, centre-anchored scale, top-left anchor, and no edge
smearing, checked against the test pattern's known patch positions. Skipped where Electron is absent.

### 4.10 Modulation & value resolution (P2 step 3)
`src/engine/core/modulation.ts` — the full signal chain of modulation-spec §4, with the
determinism trap designed out rather than managed:

- **Envelopes are precomputed, never accumulated.** `compileModulation` walks the whole track at
  240 Hz and builds each binding's smoothed signal as a derived track; render time is a
  sample-and-interpolate. A per-frame one-pole filter would make a seek and a playthrough
  disagree on some frames only — the most expensive bug this project could have.
- Identical `(source, range, curve, envelope, look-ahead)` share one derived track (D22).
- Compilation is cached in the engine on `(project, analysis)` **object identity** — sound
  because a `RenderProject` is an immutable snapshot — so the track walk never runs per frame.
- Sources implemented: `band`, `progress`, `ramp`, `lfo` (sine/triangle/saw/square/noise/
  sample-hold), `noise`. Everything else (`rms`, `onset`, `beat`, `centroid`, `flux`, structural,
  lyric, `parameter` chaining, beat-synced LFO, quantisation) is **reported as unsupported and the
  binding kept inactive** — they need analysis tracks or a beat grid that `src/analysis/` does not
  produce yet (§4.4), not modulation work.
- Curves: linear, exp/pow, log, s-curve, threshold, stepped. The `amount` mapping per curve is
  part of every project's appearance and is pinned by tests.
- Auto-calibration (§7): p10 → 0, p90 → 1 across the track. Generators skip it — they are already
  0..1, and calibrating an LFO is meaningless.
- Accumulation (§9): explicit `order`, id as tie-break so the document's array order never
  matters; `multiply` is `acc *= (1 + out)` (D21); `replace` ends the chain.
- Randomness is `hash(seed, bindingId, eventIndex)` keyed on the cycle number, never a counter.

`src/engine/core/params.ts` now implements the whole of module-spec §5: base → (aspect override,
applied in `snapshot.ts`) → automation (reserved, S1) → modulation → **clamp once at the end** →
coerce. Clamping moved to the end deliberately: an intermediate may legally exceed the range, so
`multiply` after `add` no longer behaves differently depending on where the base sat. Discrete
targets follow D25 — bool thresholds at 0.5, enums modulate by option index; colour and stem
params report that they have no numeric axis rather than guessing.

GPU-verified in `tests/golden/layout-gpu.test.ts`: a band-driven, enveloped binding renders
byte-identical frames whether the frames are reached in order or jumped to, and the frames do
differ from each other (so the check is not vacuous). `npm run spike:determinism` still produces
hash `5f0ade89…` — the unmodulated path is byte-for-byte unchanged from P0.

### 4.9 Spike and validation harness (`spike/`)
- `harness.ts` (bundle + run Electron), `electron/{main,renderer,protocol}.ts` (determinism and export modes; export config carries the whole `RenderProject`).
- `lib/determinism-run.ts` (`runDeterminismSpike`), `lib/export-run.ts` (`runExportSpike`).
- `validate.ts` + `validate/`: `context.ts`, `media.ts` (FFmpeg decode helpers), `projects.ts` (pattern, click, heavy projects; click track), `checks-render.ts` (2 determinism, 3 readback, 4 colour), `checks-system.ts` (1 environment, 5 encoders, 6 throughput, 7 stems, 8 sync).

---

## 5. Measured results

The full report is `docs/validation/p0-full-report.md`; the summary table is in PROJECT.md §4. Key points:

- **Determinism:** engine frames, export raw frames (NV12 and 10-bit) and bit-exact MP4 bytes are identical across processes.
- **Readback:** sync beats async PBO through ANGLE; GPU NV12 is fastest (1080p 197 fps, 4K 58 fps on the bars project).
- **Throughput (six-layer bars, 60 s):** H.264 1080p60 209 fps, 4K60 56 fps (NVENC-bound); HEVC 10-bit 98 / 27 fps.
- **NVENC p5:** 1080p H.264 199 / HEVC ~275 fps; 4K H.264 61 / HEVC ~92 fps. AV1 unavailable (Ampere).
- **Colour:** GPU NV12, swscale and HEVC 10-bit all within 1.2 code values of expected; black luma 16 / 64; all four tags present.
- **Stems:** `htdemucs` 4-min track in 8.6 s (28× realtime), 0.54 GB peak allocated; Python start + model load ~4 s.
- **Sync:** flash on the expected frame for 18/18 clicks; video−audio 6.67 ms (designed sub-frame rounding at a 1.01 s phase). Analysis sees clicks 5.8 ms early (centred FFT window).

---

## 6. Decisions made during implementation

- **D48** tone shoulder, knee 0.9 (owner). **D49** sRGB OETF, tagged BT.709 (owner).
- **D39 resolved** → GPU NV12 for 8-bit 4:2:0; swscale for 10-bit/4:4:4. **D50** sync readback default.
- **D40** CQ values unchanged pending real-footage quality checks; HEVC is faster than H.264 at 4K.
- uv has no download command → pip fills the wheelhouse. torch on `cu130` (driver R580+).
- FFmpeg 8 needs `setparams` to keep colour tags on filtered frames.
- **D51** (owner, 2026-09-14) settles the look-ahead sign: positive means "looks ahead", default
  **+30 ms**, sampling `source(t + lookAheadMs)`. D23's "−30 ms" describes the lag being
  compensated, not the stored field — read literally against modulation-spec §4 it would have
  increased the lag rather than cancelling it.
- Envelope `mode: linear` is specified only as "symmetric smoothing"; implemented as a single
  time constant of `(attack + release) / 2`, so switching modes does not jump.

---

## 7. Known gaps, debts and open questions

- **Tone shoulder touches fully saturated colours** (#ffffff → luma 232 instead of 235; pure primaries ~250/255).
  Owner kept D48 knowing the knee; flag again if palette-exact output becomes a requirement.
- `htdemucs_ft` not provisioned or measured (manifest entry needed: it is a bag of 4 models, each weight file pinned).
- HEVC 10-bit export is ~2× slower than H.264 because it reads RGBA10 and converts on the CPU; a GPU P010 path
  (16-bit samples packed like NV12) would likely close the gap.
- `RenderProject` is still a subset of the document: transforms, effects, modulations, masks,
  group compositing and aspect overrides parse and round-trip but are not rendered (steps 2–4).
  `toRenderProject` returns a note for each, so nothing is lost silently.
- No undo/command stack or presets yet (M8, M25).
- Schema choice worth flagging: `transform` stores `scaleX`/`scaleY` rather than PROJECT.md §7's
  single `scale`, because stretched backgrounds need non-uniform scale. Not a spec conflict —
  §7 sketches the shape, it does not pin field names.
- One visual module plus two test modules. No effects, masks, groups, text, palette roles, aspect overrides, modulation.
- `quality: 'preview'` plumbed but unused. Unknown modules warn instead of drawing a placeholder.
- Spike renderer uses `nodeIntegration` + `contextIsolation: false`; the app shell must choose a safe process layout.
- Export: no queue, pause/resume, disk-space precheck, thumbnails, motion blur, SSAA, audio stream-copy.
- Frame hashing runs on the render thread (fine for validation; move to a worker if used in long exports).
- The sidecar is spawned per command; M27 needs a supervised long-lived process with cancellation.

---

## 8. Next: P2 — Engine (PROJECT.md §10)

Goal: *"Engine renders a multi-layer project from a hand-written JSON file, headlessly, correctly at
16:9 / 9:16 / 1:1. Golden-frame tests green. The engine/shell import boundary is lint-enforced."*

Suggested order (each a commit, STATUS updated each time):

1. ✅ **Project document v1** (`src/project/`) — see §4.7. 47 tests in `tests/project/`.
2. ✅ **Layout & aspect system** — see §4.8. GPU-verified in `tests/golden/layout-gpu.test.ts`.
3. ✅ **Param resolution + modulation evaluator** — see §4.10.
4. **Effect chain contract + first effects** (module-spec §8, compositor-spec §4): scratch targets, padding,
   bloom and vignette as the first two.
5. **Golden frames** (export-spec §16): `tests/golden/` references generated on this machine from JSON projects at
   16:9 / 9:16 / 1:1, checked by a `npm run golden` (Electron) command; `--update` to regenerate deliberately.
6. **Headless render CLI** stub (`pulseforge render project.json -o out.mp4`) reusing `runExport`.
