# Pulseforge P0 validation report

> Committed copy of `out/validate/report.md` from the first full `npm run validate` on the RTX 3060
> (the owner's build machine). Re-run the script to regenerate; see docs/STATUS.md §5 for how these
> numbers changed the plan.

2026-09-14T20:00:28.421Z · full mode · 10.7 min

| # | Check | Result | Time |
|---|---|---|---|
| 1 | Environment | ✅ pass | 3 s |
| 2 | Determinism | ✅ pass | 57 s |
| 3 | Readback benchmark | ✅ pass | 120 s |
| 4 | Colour correctness | ✅ pass | 9 s |
| 5 | Encoder matrix | ✅ pass | 157 s |
| 6 | Throughput | ✅ pass | 271 s |
| 7 | Stems (Demucs) | ✅ pass | 16 s |
| 8 | A/V sync | ✅ pass | 6 s |

## 1. Environment — ✅ pass

| Item | Value |
|---|---|
| GPU | NVIDIA GeForce RTX 3060 (12288 MiB, VBIOS 94.06.25.00.8c) |
| Driver | 616.92 |
| PCIe link (max) | Gen3 x16 |
| CPU | AMD Ryzen 7 3800X 8-Core Processor (16 threads) |
| RAM | 16 GB |
| Windows | 10.0.26200 |
| Node | v24.19.0 |
| Electron / Chrome | 44.3.0 / 152.0.7977.78 |
| WebGL renderer | ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11) |
| WebGL version | WebGL 2.0 (OpenGL ES 3.0 Chromium); WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium) |
| Max texture / renderbuffer | 16384 / 16384 |
| EXT_color_buffer_float | true |
| FFmpeg | ffmpeg version n8.1.2-52-g5a03dfa0f6-20260914 Copyright (c) 2000-2026 the FFmpeg developers |
| Python / torch / CUDA | 3.11.16 / 2.13.0+cu130 / 13.0 (cuDNN 92000), CUDA available: true |
| Demucs | 4.1.0 |
| Vendored artefacts | demucs-htdemucs 955717e8; ffmpeg n8.1.2-52-g5a03dfa0f6 (BtbN autobuild-2026-09-14-13-17); python 3.11.16+20260901; uv 0.12.13 |

## 2. Determinism — ✅ pass

Engine, 600 frames at 1080p60, 2 processes × (sequential, shuffled on a fresh context, undithered): **byte-identical**; 600/600 frames differ with dither off.

| Export (2 runs) | Raw frames | MP4 bytes | Frame hash |
|---|---|---|---|
| H.264 8-bit gpu-nv12 | identical | identical | 415da9a1259a96ee… |
| HEVC 10-bit swscale | identical | identical | 049abfee79df7461… |

## 3. Readback benchmark — ✅ pass

H.264 export of the bars project, 5 s, no frame hashing. Per-frame ms; "readback" for sync includes the GPU wait.

| Resolution | Path | fps | wait GPU | readback | wait encoder |
|---|---|---|---|---|---|
| 1920×1080 | RGBA sync | 102.7 | 0.00 | 4.50 | 4.92 |
| 1920×1080 | RGBA async d1 | 79.6 | 5.53 | 6.05 | 0.69 |
| 1920×1080 | RGBA async d2 | 73.7 | 4.14 | 8.35 | 0.77 |
| 1920×1080 | RGBA async d3 | 68.6 | 4.30 | 8.80 | 1.13 |
| 1920×1080 | RGBA async d4 | 74.8 | 0.29 | 9.12 | 3.64 |
| 1920×1080 | NV12 (GPU) sync | 196.6 | 0.00 | 2.28 | 2.56 |
| 3840×2160 | RGBA sync | 29.5 | 0.00 | 15.81 | 17.56 |
| 3840×2160 | RGBA async d1 | 23.4 | 18.35 | 22.88 | 1.03 |
| 3840×2160 | RGBA async d2 | 21.9 | 14.38 | 29.45 | 1.35 |
| 3840×2160 | RGBA async d3 | 21.7 | 13.34 | 28.53 | 3.78 |
| 3840×2160 | RGBA async d4 | 21.9 | 0.87 | 32.15 | 12.22 |
| 3840×2160 | NV12 (GPU) sync | 57.8 | 0.00 | 6.15 | 10.67 |

Fastest: 1920×1080 → NV12 (GPU) sync; 3840×2160 → NV12 (GPU) sync.

## 4. Colour correctness — ✅ pass

24 patches (grey ramp, primaries, palette, two above the tone knee), dither off, frame 30 decoded with an explicit BT.709 limited-range matrix. Expected = authored sRGB → linear → tone shoulder (D48) → sRGB OETF (D49). Tolerance ±3 code values.

| Path | Result | Max Δ (8-bit) | Worst patch | Luma black / white code | Tags |
|---|---|---|---|---|---|
| H.264 8-bit, GPU NV12 | pass | 1.2 | #ffffff | 16 / 232 (expect 16 / 231) | all 4 present |
| H.264 8-bit, swscale | pass | 1.2 | #ffffff | 16 / 232 (expect 16 / 231) | all 4 present |
| HEVC 10-bit, swscale | pass | 0.6 | #00e0e0 | 64 / 928 (expect 64 / 926) | all 4 present |

Limited range: black luma must be 16 (64 at 10-bit). The white patch is not 235 because #ffffff sits above the D48 tone knee and encodes at ~0.98.

## 5. Encoder matrix — ✅ pass

NVENC encode speed from an in-process `testsrc2` source (300 frames, source generation time subtracted); D40 quality (CQ 17 H.264 / 19 HEVC, VBR, lookahead 32, 3 B-frames). Size is for synthetic content — relative, not representative of real footage.

| Size | Variant | Preset | Encode fps | MB / min |
|---|---|---|---|---|
| 1920x1080 | h264-8-420 | p1 | 458 | 235 |
| 1920x1080 | h264-8-420 | p5 | 199 | 239 |
| 1920x1080 | h264-8-420 | p7 | 175 | 237 |
| 1920x1080 | h264-8-444 | p1 | 431 | 301 |
| 1920x1080 | h264-8-444 | p5 | 218 | 305 |
| 1920x1080 | h264-8-444 | p7 | 202 | 303 |
| 1920x1080 | hevc-8-420 | p1 | 420 | 120 |
| 1920x1080 | hevc-8-420 | p5 | 271 | 120 |
| 1920x1080 | hevc-8-420 | p7 | 132 | 120 |
| 1920x1080 | hevc-10-420 | p1 | 448 | 120 |
| 1920x1080 | hevc-10-420 | p5 | 278 | 120 |
| 1920x1080 | hevc-10-420 | p7 | 139 | 120 |
| 1920x1080 | hevc-8-444 | p1 | 403 | 127 |
| 1920x1080 | hevc-8-444 | p5 | 274 | 127 |
| 1920x1080 | hevc-8-444 | p7 | 136 | 126 |
| 1920x1080 | hevc-10-444 | p1 | 332 | 129 |
| 1920x1080 | hevc-10-444 | p5 | 323 | 128 |
| 1920x1080 | hevc-10-444 | p7 | 154 | 128 |
| 3840x2160 | h264-8-420 | p1 | 187 | 867 |
| 3840x2160 | h264-8-420 | p5 | 61 | 887 |
| 3840x2160 | h264-8-420 | p7 | 52 | 888 |
| 3840x2160 | h264-8-444 | p1 | 152 | 938 |
| 3840x2160 | h264-8-444 | p5 | 65 | 960 |
| 3840x2160 | h264-8-444 | p7 | 59 | 963 |
| 3840x2160 | hevc-8-420 | p1 | 168 | 238 |
| 3840x2160 | hevc-8-420 | p5 | 91 | 238 |
| 3840x2160 | hevc-8-420 | p7 | 38 | 240 |
| 3840x2160 | hevc-10-420 | p1 | 181 | 237 |
| 3840x2160 | hevc-10-420 | p5 | 94 | 240 |
| 3840x2160 | hevc-10-420 | p7 | 40 | 239 |
| 3840x2160 | hevc-8-444 | p1 | 154 | 245 |
| 3840x2160 | hevc-8-444 | p5 | 90 | 244 |
| 3840x2160 | hevc-8-444 | p7 | 39 | 245 |
| 3840x2160 | hevc-10-444 | p1 | 95 | 246 |
| 3840x2160 | hevc-10-444 | p5 | 102 | 248 |
| 3840x2160 | hevc-10-444 | p7 | 45 | 248 |

Not available on this GPU/driver: AV1 8-bit 4:2:0.

## 6. Throughput — ✅ pass

60 s exports of a six-layer bars project (normal/add/screen blends), sync readback, no frame hashing. This bounds the pipeline; real projects with bloom and 3D will be shader-bound and slower.

| Export | fps | Realtime | Wall | render ms | readback ms | wait encoder ms | Size | Verify |
|---|---|---|---|---|---|---|---|---|
| 1080p60 H.264 (GPU NV12) | 209.2 | 3.49× | 18.0 s | 0.13 | 2.59 | 2.04 | 84 MB | pass |
| 4K60 H.264 (GPU NV12) | 56.0 | 0.93× | 66.1 s | 0.16 | 7.29 | 10.37 | 178 MB | pass |
| 1080p60 HEVC 10-bit (swscale) | 97.6 | 1.63× | 37.6 s | 0.20 | 5.60 | 4.41 | 54 MB | pass |
| 4K60 HEVC 10-bit (swscale) | 26.7 | 0.45× | 136.1 s | 0.20 | 20.26 | 16.91 | 87 MB | pass |

## 7. Stems (Demucs) — ✅ pass

240 s synthetic stereo track, 44.1 kHz, CUDA, shifts 1, overlap 0.25, driven from Node over the JSON-lines sidecar protocol with live progress events. VRAM = torch peak allocated / reserved.

| Model | Separation | Realtime | Model load | Peak VRAM | Progress events | Notes |
|---|---|---|---|---|---|---|
| htdemucs | 8.6 s | 28.0× | 0.6 s | 0.54 / 0.71 GB | 22 | wall incl. Python start 12.6 s |
| htdemucs_ft | not installed | — | — | — | — | setup fetches htdemucs only (D8); add htdemucs_ft to setup/manifest.ts to measure |

A 4-minute track corresponds to the figures above.

## 8. A/V sync — ✅ pass

Flash layer on a fixed schedule (first 1.01 s, every 0.5 s) and 5 ms clicks at the same times; exported H.264 + AAC, then both streams decoded from the MP4 (AAC priming handled by FFmpeg).

| Measure | Result |
|---|---|
| Clicks / video onsets / audio onsets | 18 / 18 / 18 |
| Flash on the first frame at or after each click | yes, every click |
| Video − audio onset | mean 6.67 ms, worst |6.71| ms (must be within one frame, 16.67 ms) |
| Lit frames | 54 (expected 54) |
| Analysis onset vs click (informational) | −5.8 ms over 18 clicks (240 Hz frames, 2048-sample FFT window; negative = the analysis sees the click before it happens) |

> This row was corrected after the full run: the original detector used an absolute threshold that never fired and printed an empty mean as 0.0 ms. Check 8 was re-run alone with a relative threshold (`npm run validate -- --only 8`); every other value in this section was unchanged.
