# Export Pipeline & Determinism — detailed specification

> Companion to [PROJECT.md](../PROJECT.md) §5, §8.8, §14, and [module-spec.md](module-spec.md) §7.
> Design spec, not implementation. Status: draft for review. Last updated: 2026-09-14.

---

## 0. The guarantee

> Given the same project, the same audio and the same app version, an export produces
> **byte-identical frames**, with **perfect A/V sync**, at **any resolution**, regardless of
> how long each frame takes to render.

The contract is enforced on the **raw frames the engine hands to the encoder**. The MP4 file
itself is also expected to be byte-identical on the same machine, driver and FFmpeg build, but
only with bit-exact muxing (§5.1) — containers otherwise embed creation timestamps and encoder
version strings, and hardware encoders are not guaranteed bit-stable across driver versions. A
raw-frame mismatch is an engine bug; a file mismatch with matching frames is an encoder/muxer
matter, reported separately.

Everything here follows from that sentence. The export path never races the clock, never drops a
frame, and never depends on how fast the machine is. Slow is acceptable; wrong is not.

This is also why export is *not* "record the preview". Capture-based export inherits every
hitch, every GC pause and every shader compile stall as a visible glitch in the final file. The
offline path trades wall-clock time for a guarantee.

---

## 1. Pipeline

```
[1] PREPARE      validate project, resolve assets, ensure analysis + stems ready,
                 probe encoder, allocate targets, warm shader cache
        │
[2] AUDIO        decode → trim → fades → lead-in/out padding → export-ready PCM/AAC
        │
[3] FRAME PUMP   for n in 0..N-1:  t = exact(n, fps)  →  engine.renderFrame(t)
        │
[4] READBACK     async PBO, pipelined N frames deep → raw RGBA in host memory
        │
[5] CONVERT      flip + colour convert (GPU) → packed pixel format
        │
[6] ENCODE       write to FFmpeg stdin → NVENC → elementary stream
        │
[7] MUX          video + audio → container, faststart, metadata
        │
[8] VERIFY       ffprobe: duration, frame count, sync; write render report
```

Steps 3–6 form a pipeline, not a sequence: while frame `n` is being read back, frame `n+1` is
rendering and frame `n-2` is being encoded. Depth is bounded (§4.2) so a stalled encoder applies
backpressure rather than exhausting memory.

---

## 2. Time — exact, never accumulated

**Frame time is computed from the integer frame index, never accumulated.**

```
t(n) = n / fps        as exact rational arithmetic
```

Accumulating `t += 1/fps` in float64 drifts. At 60 fps over a 5-minute track that is 18,000
additions of a value that isn't representable in binary floating point; the error is small but
nonzero and monotonically growing, and it is exactly the kind of thing that puts the last frames
of a long track fractionally out of step with the audio. Deriving `t` from `n` each time makes
drift structurally impossible.

- `fps` is stored as a rational (`60000/1001` for 59.94, `60/1` for 60) — never a float.
- Frame count, with `fps = num/den` and 48000 ticks per second: `N = ceil(durationTicks * num / (48000 * den))`, computed in integers (BigInt or exact integer division — `durationTicks * num` exceeds 2^53 only for absurd durations, but check rather than assume).
- **Frame start in ticks is `n * 48000 * den / num`.** That is an integer for integer fps that divides 48000 (24, 25, 30, 48, 50, 60, 120…) but **not** for NTSC rates: at 59.94 a frame is 800.8 ticks. So `t` is always derived from the rational, and when a frame boundary must be expressed in ticks (snapping, range bounds) it is rounded with one documented rule: `floor`.
- The engine receives both `t` (seconds, float64, derived) and `frameIndex` (exact). Modules needing exact positions use `frameIndex`.
- Timeline time, not audio-file time (PROJECT.md §8.10). Lead-in padding means frame 0 is usually *before* the audio starts.

---

## 3. Rendering for export vs preview

Same engine, same code path, different context flags:

| | Preview | Export |
|---|---|---|
| `t` source | audio clock (§8.12) | `n / fps`, exact |
| Resolution | scaled (0.25–1.0) | full target |
| `quality` | `preview` | `final` |
| Supersampling | off | optional 2× SSAA |
| Motion blur | off | optional (§9) |
| Frame skipping | allowed | **never** |
| Readback | none | every frame |

Modules may reduce *fidelity* in preview but never composition (module-spec §7 rule 5).

---

## 4. Readback — the likely bottleneck

> **P0 result (D39, D50):** on the RTX 3060 through Electron's ANGLE/D3D11 backend, synchronous
> `readPixels` beat the PBO ring, and bytes per frame — not GPU stalls — were the bottleneck.
> Exports therefore convert to NV12 on the GPU (8-bit 4:2:0) and read synchronously. §4.2's PBO
> design is implemented (`src/engine/render/readback.ts`) and kept as an option for re-measurement.

### 4.1 Why it matters
4K RGBA8 is 33 MB per frame; at 60 fps that's ~2 GB/s across PCIe. Within budget for a x16 Gen4
link — *if* the transfer is asynchronous. A synchronous `glReadPixels` stalls the GPU until the
transfer completes, serialising render and transfer and potentially halving throughput. This is
the single most likely performance surprise in the whole project, which is why P0 measures it
before anything else is built on top.

### 4.2 Strategy
- **Pixel Buffer Objects, ring of 3–4.** Issue `readPixels` for frame `n` into `PIXEL_PACK_BUFFER` `n mod k` and create a `fenceSync`; once the fence for PBO `n-k` has signalled, copy it out with `getBufferSubData`.
- **WebGL2 is not native GL here.** There is no `mapBufferRange` in WebGL2, so every readback is a copy. In Electron on Windows the calls also go through ANGLE → D3D11 in Chromium's GPU process, adding a cross-process hop. PBO throughput figures from native OpenGL do not transfer — P0 measures the real path.
- **Fence-based polling** (`clientWaitSync` with a zero timeout, or `getSyncParameter`), never a `getBufferSubData` on an unsignalled fence — that blocks exactly like a synchronous read.
- **Bounded queue** between readback and the encoder writer. If FFmpeg's stdin applies backpressure, the queue fills, the pump pauses, and memory stays flat. Node stream `drain` handling is mandatory here — ignoring it is how a renderer quietly accumulates gigabytes of buffered frames.
- **No per-frame IPC copies.** A 4K frame is 33 MB; pushing 60 of them a second from the renderer to the main process over Electron IPC is a second bottleneck on top of readback. The frame pump and the FFmpeg stdin writer must share a process (for example an export renderer with Node access that spawns FFmpeg itself, or shared memory to a utility process). PROJECT.md §5 places FFmpeg under the shell for everything else; for the export pipe, P0 picks the arrangement and measures it.
- Depth is configurable and reported in the render report; deeper costs VRAM (each 4K PBO is 33 MB) and hides more latency.

### 4.3 Format and orientation
- Read as **RGBA8** (aligned, fast path) even though alpha is usually discarded; `RGB8` rows need padding and are generally slower.
- **OpenGL is bottom-up, video is top-down.** Flip on the GPU in the final blit — a CPU flip of 33 MB per frame is pure waste.
- Row alignment set explicitly (`glPixelStorei`), or 4K-adjacent odd widths produce skewed frames — a classic and very confusing bug.
- **10-bit exports need a 10-bit source.** RGBA8 readback feeding a 10-bit HEVC encode produces 8-bit data in a 10-bit container, which does nothing against banding. For 10-bit output the final blit writes an **`RGB10_A2`** target (core WebGL2, renderable, read back with `UNSIGNED_INT_2_10_10_10_REV` — still 4 bytes per pixel, so the same PCIe cost as RGBA8), and the encoder receives `x2bgr10le` or `p010le`. The exact packed layout is verified in P0 check 4.

### 4.4 Colour conversion — where?
Three options. **Per D39, the RGBA path is built first behind an interface; P0's readback numbers
decide whether to switch to (b).**

| Where | Cost | Notes |
|---|---|---|
| (a) FFmpeg CPU (`swscale`) | High CPU, ~1 core+ at 4K60 | Simplest, works, wasteful. Matrix and range fully controlled by FFmpeg flags |
| (b) GPU shader → NV12 (or P010 for 10-bit), read back subsampled | Cheap GPU, **~half the PCIe traffic** (NV12 is 12 bpp vs 32) | The likely end state if readback is the bottleneck. Means owning the matrix, range and chroma siting |
| (c) Feed RGBA to NVENC directly | NVENC converts on the GPU | FFmpeg's `h264_nvenc`/`hevc_nvenc` accept `rgba`/`bgra`/`rgb0` (and `x2bgr10le`) on the pipe, so no special binding is needed. **But the matrix NVENC applies internally isn't documented or controllable from FFmpeg** — P0 check 4 must confirm it matches the BT.709 limited-range tags before relying on it |

Option (b) is a meaningful win: NV12 at 4K is 12.4 MB/frame instead of 33 MB. Note that NV12/P010
are 4:2:0; a `yuv444p` master (§5.3) needs a full-resolution chroma readback instead, which gives
back most of the saving. Getting the RGB→YUV matrix wrong has a famous visual signature — see §6.

---

## 5. Encoding

### 5.1 Invocation shape
FFmpeg is spawned as a child process with raw frames on stdin:

```
ffmpeg -y
  -f rawvideo -pix_fmt rgba -s WxH -framerate NUM/DEN -i pipe:0   # RGBA path first (D39)
  -i audio.wav                                            # prepared audio (§7)
  -map 0:v -map 1:a
  -c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 17 -b:v 0       # CQ 17 for 8-bit H.264 (D40)
     -profile:v high -g 120 -bf 3 -rc-lookahead 32
     -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
  -c:a aac -b:a 320k                                      # or -c:a copy when untouched
  -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact
  -movflags +faststart
  out.mp4
```

10-bit HEVC master variant: `-pix_fmt x2bgr10le` (or `p010le` if P0 moves conversion to the GPU)
on the input, `-c:v hevc_nvenc -profile:v main10 -cq 19` (D40), same colour tags. The bit-exact
flags strip creation timestamps and encoder version strings, so repeat renders can be compared at
file level (§0). The H.264 level is left to FFmpeg; if a delivery target needs a fixed level, it
belongs in the export preset.

The exact command line is **recorded verbatim in the render report** (PROJECT.md M34). Being able
to see precisely what produced a file is worth more than any amount of guessing a year later.

### 5.2 NVENC settings that matter on Ampere
- **`preset p1..p7`** — p1 fastest, p7 slowest/best. p5–p6 is the sweet spot for offline work where render time is dominated by shaders anyway.
- **`-rc vbr -cq N -b:v 0`** — constant-quality VBR. Defaults: CQ 17 for 8-bit H.264, CQ 19 for the 10-bit HEVC master (D40). CQ 17–19 is visually transparent for this content; lower for heavy grain or fine particles.
- **`-rc-lookahead 32`, `-bf 3`** — lookahead and B-frames improve quality per bit. Latency is irrelevant offline, so use them.
- **`-g` (GOP)** = 2× fps is a reasonable default.
- **No AV1 encode on Ampere** (PROJECT.md §4). Probe with `ffmpeg -encoders` and hide unsupported options rather than failing at render time.

### 5.3 Chroma subsampling — relevant to *this* project's aesthetics
Default `yuv420p` subsamples chroma 2×2. On saturated, high-contrast content — **neon magenta on
black, thin bright lines, small crisp typography** — this produces visible colour fringing and
smeared edges. Both of the stated aesthetics (neon glow, minimal typography) are exactly the
content that shows it worst.

Mitigations, in order of practicality:
1. **Raise the bitrate / lower CQ** — helps, cheaply.
2. **Keep bright thin elements ≥ 2 px** at the export resolution; the layout system's resolution-independent line widths (§8.11) already push this way.
3. **`yuv444p` master** — Ampere NVENC supports 4:4:4 for H.264 and HEVC. Larger files, and YouTube will re-encode to 4:2:0 anyway, but it's the right choice for an archival master or anything that will be re-edited.
4. **Export 4K even for 1080p delivery** — downscaling at the platform averages the chroma error away. A cheap and very effective trick for text-heavy content.

### 5.4 Codec choice
- **H.264** — default. Universal, fast, fine at these bitrates.
- **HEVC** — better quality per bit, 10-bit support (useful against banding in the dark gradients the neon look depends on — provided the source is 10-bit, §4.3). Less convenient to hand around.
- **No CPU encoder** (D5). If NVENC is unavailable, export is disabled with a message that says why and what to check (driver, GPU).

---

## 6. Colour management

The compositor works in **linear light** (PROJECT.md S11) — bloom, blending and gradients are all
wrong in sRGB space, and glows in particular look muddy. Conversion to the output transfer
function happens once, in the final blit.

Then the classic failure: **limited vs full range.** Video is conventionally limited range
(16–235 for 8-bit luma). Writing full-range values while tagging the file as limited — or the
reverse — gives washed-out blacks or crushed shadows, and it is *the* most common way a render
looks subtly wrong compared to the preview.

So the rules are explicit:
- Encode with the **sRGB OETF** in the compositor's output pass, the same as preview (D49), so the export matches what was seen while editing.
- Convert with the **BT.709** matrix for HD/UHD.
- Write **limited range** (`color_range: tv`) by default and tag it, matching what players expect.
- Always write all four tags — `colorspace`, `color_primaries`, `color_trc`, `color_range`. An untagged file is interpreted by guesswork, and different players guess differently.
- Offer full range as an option for masters that will be re-edited, tagged correctly.
- **Verify in P0** by rendering a known ramp and probing the decoded values. This is far cheaper to check once than to debug later from "the export looks a bit flat".

---

## 7. Audio

- Decoded once, then **trimmed, faded and padded** per the clip model (PROJECT.md §8.10) into an export-ready WAV in the scratch directory.
- **Stream-copy the original only when nothing touched it** — no trim, no fades, no padding, and the source codec is container-legal. Otherwise re-encode to AAC 320k. Silently re-encoding when a copy was possible loses quality for nothing; silently copying when a fade was applied ships the wrong audio.
- **Duration reconciliation:** video duration is `N/fps`; audio is a sample count. They rarely land on exactly the same value. Policy: video length is authoritative, audio is padded with silence or trimmed by at most one frame's worth, and any adjustment is logged. Avoid `-shortest`, which resolves the mismatch by truncating whichever stream happens to be shorter — including, sometimes, the video's final frame.
- Sample-accurate alignment: audio starts at `leadInMs`, i.e. sample `round(leadInMs * sampleRate / 1000)`.
- A **karaoke variant** (PROJECT.md S15) substitutes the instrumental stem sum; everything else is identical.

---

## 8. Stateful layers & seeking

Export renders strictly sequentially from frame 0, which is the easy case — stateful modules
(particles, feedback trails) step naturally. The hard case is *preview seeking*, and the export
path is what defines correctness for it:

- Stateful modules declare a **checkpoint interval**; the engine captures state at those points during sequential playback.
- A seek to `t` restores the nearest earlier checkpoint and fast-forwards deterministically at the fixed internal timestep.
- Export may also need a **warm-up** when rendering a sub-range (`renderRange`): start from the nearest checkpoint before the range, render discarded frames up to the range start, then begin writing. Without this, a partial re-render of a section shows particles popping into existence — obviously wrong, and obviously a bug the first time anyone re-renders one section.
- A module failing the seek-stability conformance test (module-spec §11.2) is **blocked from export**, usable in preview only, flagged.

---

## 9. Motion blur & supersampling

- **Temporal supersampling**: render `k` subframes across the shutter interval `t ± (shutter/2)/fps` and accumulate weighted. Cost is linear in `k`; `k=4..8` and a 180° shutter is the film-like default. Fully deterministic, since each subframe is its own pure evaluation.
- **Spatial SSAA**: render at 2× and downsample. Expensive (4× fragment cost) but the most reliable quality improvement, and it fixes the thin-line shimmer that thin neon geometry produces.
- **MSAA is not generally usable** — it doesn't survive the post-processing chain, since effects sample resolved textures. SSAA is the honest option.
- Both are export-only and reported in the render report.

---

## 10. Alpha export — **out of scope** (D5)

Cut deliberately. NVENC cannot encode alpha in any profile it exposes, so transparency would have
required a whole second encoding path — ProRes 4444 or VP9 on the CPU, with its own format matrix,
its own performance profile and its own failure modes — to serve a use case that isn't wanted
here. Everything ships as a self-contained NVENC MP4.

The consequence worth stating: there is now **no CPU encoder path in v1 at all** — no `libx264`
fallback either. PNG sequences and ProRes are Won't-haves (PROJECT.md W7).

---

## 11. Multi-aspect export

One project, several outputs (PROJECT.md §8.11):
- The analysis cache, stems, decoded audio and glyph atlases are **shared across aspects** — only rendering and encoding repeat.
- Each aspect resolves its own per-aspect parameter overrides; everything else is identical.
- Queued as separate jobs with a shared prepare step, so "1080p landscape + 1080×1920 vertical + square" is one action and three files.
- Per-aspect export presets carry their own codec/bitrate settings.

---

## 12. Render queue

```
RenderJob {
  id, projectPath, projectSnapshotHash, aspect, preset,
  range { inTicks, outTicks } | full,
  output path, status, progress { frame, total, fps, etaMs },
  startedAt, finishedAt, error?, reportPath
}
```

- **Snapshot on enqueue.** The job renders the project *as it was when queued* — editing while a render runs must not corrupt the output. This also makes "queue three variants and keep working" safe, which is the main reason to have a queue at all.
- Persisted to disk, so a crash or reboot doesn't lose the queue; jobs resume or restart cleanly.
- Sequential by default (they contend for the same GPU — PROJECT.md M28). The ML sidecar yields to an active render.
- Overnight batch: queue many jobs, optional shutdown-when-done, notification on completion.

---

## 13. Progress, pause, cancel

- Progress from the **encoder's** frame count, not the pump's — the pump runs ahead, and reporting its position makes the last few seconds of a render appear to hang.
- ETA from a windowed moving average (last ~10 s), not a cumulative one; heavy sections otherwise poison the estimate for the rest of the render.
- Live thumbnail, throttled to ~2 fps and taken from an already-read-back frame, so preview costs nothing extra.
- **Pause** = stop issuing frames; the GL context and FFmpeg process stay alive with stdin idle. Resume continues exactly where it stopped, which is safe precisely because frame time is derived from `n`.
- **Cancel** = close stdin, let FFmpeg finish its current frame, then delete the partial output unless "keep partial" is set. A half-file left silently on disk is worse than none.

---

## 14. Failure handling

| Failure | Detection | Response |
|---|---|---|
| FFmpeg exits nonzero | exit code + stderr tail | Parse for known causes (unsupported pix_fmt, encoder unavailable, disk full); show the cause, not the raw log |
| Encoder unavailable | startup probe | Hide the option before it can be chosen; if no NVENC encoder at all, disable export and say why (no CPU fallback — D5) |
| Disk fills mid-render | write error + free-space precheck | Precheck estimated size before starting; pause rather than corrupt |
| GPU OOM | GL error / context loss | Reduce readback depth and supersampling, retry once, then fail with a specific message |
| Context lost (driver reset) | `webglcontextlost` | Fail the job cleanly, keep the queue, offer resume from the last completed frame |
| Shader compile failure | compile status | Report module, source line and layer; block export rather than render a black layer |
| Stalled pipe | no progress within a timeout | Fail with diagnostics rather than hanging overnight |

**Estimate output size before starting** (`bitrate × duration` plus headroom) and check free space.
Filling a disk at 3 a.m. during a batch is a preventable failure.

---

## 15. Verification

After every render, automatically:
- `ffprobe` the output: duration, frame count, fps, codec, pixel format, colour tags.
- Assert frame count == `N` exactly. Any discrepancy is a bug, not a rounding artefact.
- Assert audio duration within one frame of video duration.
- Write the **render report** beside the output (PROJECT.md M34): project name and hash, seed, engine version, module ids and versions, resolution/fps/codec settings, the full FFmpeg command, per-frame timing stats, per-layer GPU cost, VRAM high-water mark, readback depth, warnings, and every guardrail or fallback that fired.

**Determinism self-check** (opt-in, or automatic for short ranges): re-render a small range and
compare per-frame raw hashes against the first pass. Cheap, and it catches a broken module the day it breaks
rather than three projects later.

---

## 16. Golden-frame testing across two machines

Given the dev/run split (PROJECT.md §14):

- **References are generated on the RTX machine** and committed (small PNGs, or hashes plus a few full frames). Frames rendered on the Intel iGPU will not match the 3060 bit-for-bit — different drivers, different rounding in filtering and precision.
- **Tolerance policy:** *bit-exact* for repeat renders on the same machine (this is the actual determinism contract). *Perceptual* (small SSIM/ΔE budget) for cross-machine comparison, which exists to catch gross breakage, not to enforce identity.
- **On the laptop**, tests cover the engine's pure layer: modulation evaluation, envelope precomputation, layout and aspect resolution, time mapping, schema round-trips, preset migration, FFmpeg argument construction. That's where most bugs live and none of it needs a GPU.
- **On the home PC**, `npm run validate` re-renders the golden set and reports mismatches.

---

## 17. The P0 validation script

The concrete first deliverable (PROJECT.md P0). Run on the home PC, prints a pasteable report:

1. **Environment** — GPU, driver, CUDA, FFmpeg build, available encoders, WebGL2 limits and required extensions (`EXT_color_buffer_float`), ANGLE backend, PCIe link generation/width.
2. **Determinism** — render a 10 s 1080p60 clip twice. **Primary:** SHA-256 of every raw frame handed to the encoder — *must be identical*. **Secondary:** SHA-256 of the two MP4s with bit-exact muxing (§5.1) — reported; a mismatch here with identical frames is an encoder/muxer finding, not an engine failure.
3. **Readback benchmark** — sync vs async PBO at 1080p and 4K, depths 1–4, including the frame transport to FFmpeg's stdin (§4.2); report ms/frame and effective throughput. Decides §4.2 defaults and D39.
4. **Colour correctness** — render a known ramp, encode, decode, compare values; verify range/tag handling (§6) for each conversion path in use (§4.4), and the 10-bit `RGB10_A2` → `x2bgr10le` layout (§4.3).
5. **Encoder matrix** — H.264/HEVC × 420/444 × presets p1/p5/p7: encode fps and file size at 1080p and 4K.
6. **Throughput** — full 60 s render at 1080p60 and 4K60 on a representative project: end-to-end fps and where time goes (render / readback / encode).
7. **Stems** — `htdemucs` and `htdemucs_ft` on a 4-minute track: wall time, peak VRAM.
8. **Sync** — render a click-track project; verify the visual impulse lands on the audio transient within one frame.

Every number in PROJECT.md §4 is a placeholder until this report exists.

---

## 18. CLI (PROJECT.md S14)

```
pulseforge render <project.pvproj> [--aspect 16:9] [--preset youtube-4k]
                  [--range 0:30-1:45] [--out path] [--verify] [--json]
```

Possible only because the engine is headless-capable and the export path shares no code with the
UI. It also makes overnight batches scriptable and gives CI something to call.

---

## 19. Open questions — resolved

Settled in [decisions.md](decisions.md):
- **NV12-on-GPU**: build the RGBA path first behind an interface; P0's readback numbers decide whether to switch (D39).
- **Default quality**: CQ 17 for 8-bit H.264, CQ 19 for the 10-bit HEVC master (D40), revisited after P0's encoder matrix.
- **Determinism self-check**: off by default, automatic under 30 s, always in CI (D41).
- **Partial re-render**: v1.x, once the stateful warm-up path is solid (D42).
- **Frame-server mode**: Could-have (D43).
- **`quality: final` is forced on export** (D20).

---

## 20. Dependencies

- **[module-spec.md](module-spec.md) §7** — the render contract; §11 conformance gates what may be exported.
- **[modulation-spec.md](modulation-spec.md) §5** — precomputed envelopes are what make sequential export and arbitrary seeking agree.
- **PROJECT.md §4** — hardware envelope; §8.10 time model; §8.11 aspects; §8.14 cache; §8.15 render reports; M28 GPU queue.
