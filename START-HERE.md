# Start here — moving to the RTX machine

## 1. Before you open Claude Code

**Copy the folder to a path with no spaces.** Recommended: `D:\pulseforge`

This matters more than it looks. The project creates a portable Python environment, a vendored
wheelhouse and an FFmpeg install under `vendor/`, and spawns them as child processes. Paths with
spaces (and especially the ` - ` in the current folder name) cause quoting bugs in Python tooling,
shell invocations and FFmpeg arguments that are tedious to chase down. Rename now, once.

**Install these on the RTX machine** (all need internet, once):

```bash
winget install OpenJS.NodeJS.LTS Git.Git
```

Then check the GPU is visible:

```bash
nvidia-smi
```

**Initialise the repo** in `D:\pulseforge`:

```bash
git init && git add -A && git commit -m "Planning phase: full specification"
```

Do this *before* any code exists, so the specs are a clean baseline you can always diff against.

## 2. Open Claude Code pointed at `D:\pulseforge`

`CLAUDE.md` loads automatically in every session in that folder — it carries the hard constraints,
the reading order and the conventions, so you never have to re-explain the project.

## 3. Paste this as your first message

---

```
Read CLAUDE.md, then PROJECT.md, then docs/decisions.md. Skim docs/coverage-audit.md
for the document map. Then read docs/export-spec.md in full — it defines this phase.

We are starting P0. The entire planning phase is done and every decision is recorded;
your job is to build, not to re-plan. If a decision looks wrong, say so and explain
why rather than quietly deviating.

P0 is a spike whose only purpose is to replace the performance estimates in
PROJECT.md §4 with real measurements from this machine (Ryzen 7, RTX 3060 12GB).
No UI. No app shell beyond what the spike needs. Ugly is fine.

Build, in this order:

1. Repo scaffolding: package.json, TypeScript strict config, the src/ layout from
   PROJECT.md §13, and — from the first commit — the lint rule that forbids
   src/engine/ from importing Electron, the DOM, React, or anything time-aware.
   That boundary is load-bearing; enforce it before there is anything to enforce.

2. A minimal provisioning script (npm run setup) that fetches a pinned NVENC-capable
   FFmpeg build into vendor/ with SHA-256 verification, plus the portable Python
   environment and the htdemucs model per PROJECT.md §3. Resumable, re-runnable,
   and loud about exactly what failed. I cannot debug this over your shoulder —
   a stack trace is a bug in the setup script, not a diagnosis.

3. The minimum engine needed to render one bar visualizer deterministically:
   the time/PRNG/parameter core, a WebGL2 compositor that can draw a single layer,
   and the analysis pipeline reduced to FFT + one frequency band. Follow
   docs/module-spec.md §7 for the render contract and docs/compositor-spec.md
   §1-3 for linear-light compositing and premultiplied alpha — those two get
   locked in now because changing them later changes every project's appearance.

4. The offline frame pump and NVENC export path per docs/export-spec.md §2-6:
   frame time derived from the integer frame index (never accumulated), async PBO
   readback, raw frames to FFmpeg stdin, muxed with audio.

5. npm run validate — the eight checks in docs/export-spec.md §17, printing one
   pasteable report: environment, determinism (render twice, compare SHA-256),
   sync vs async readback at 1080p and 4K, colour/range correctness, the encoder
   matrix, end-to-end throughput, Demucs timings and VRAM, and click-track sync.

Work through these in order and check in with me after each one. Start with 1 and 2,
and stop before running setup so I can see what it will download first.

Two things I care about more than speed of delivery: that determinism is real and
tested from the first frame rendered, and that when something breaks on my machine
the error tells me what to do about it.
```

---

## 4. What to expect

- Steps 1–2 involve no GPU work; they'll go quickly.
- Setup will download roughly 3–4 GB for the core tier (FFmpeg, Python, torch-CUDA, `htdemucs`). The full install with Whisper models lands around 8–9 GB.
- Step 5's report is the deliverable. **Paste it back into this planning session** (or any session) and the estimates in `PROJECT.md` §4 get replaced with real numbers — which then settle several deferred choices: readback pipeline depth, whether to convert to NV12 on the GPU (D39), and the default CQ (D40).

## 5. If the spike fails

That's a successful P0. The whole point of doing it first is to find out cheaply. The two
failures that would change the architecture:

- **Readback can't keep up at 4K** → NV12-on-GPU conversion moves from optional to required, and the pipeline depth needs rethinking.
- **Renders aren't byte-identical** → something in the stack is non-deterministic, and finding it in a 200-line spike is vastly easier than finding it in a finished app.

Report either back and the plan adapts. Both are known risks with documented mitigations
(`PROJECT.md` §10).
