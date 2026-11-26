# Studio UI — detailed specification

> Companion to [PROJECT.md](../PROJECT.md) §8.9, and the module/modulation/lyrics specs.
> Design spec, not implementation. Status: draft for review. Last updated: 2026-09-14.

---

## 0. Principles

The reference is **Shimga.app**: dark studio chrome, left asset rail, centre canvas, right
inspector, bottom timeline. Proven and dense. Not reinventing it.

Four principles govern the decisions below:

1. **The schema generates the UI.** Panels come from module declarations (module-spec §13), not hand-written forms. A new effect gets a good panel for free, or the library can't grow.
2. **Everything is undoable.** Every mutation is a command. A creative tool where some actions can't be undone teaches you to be timid, and timid is the opposite of what this is for.
3. **Show the audio.** Waveforms, beat grid, source scopes, live modulated values. The user is editing a *reaction to sound*; hiding the sound makes that guesswork.
4. **Preview is honest about being a preview.** Reduced resolution is fine. Silently differing from the export is not — so any divergence is labelled.

---

## 1. Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ New  Import   ↶ ↷    [project name]        Save Preset   ▸ EXPORT   ⚙        │
├────────────┬────────────────────────────────────────────┬────────────────────┤
│ PRESETS    │                                            │ VISUALIZER         │
│ AUDIO      │            CANVAS PREVIEW                  │ EFFECTS            │
│ ASSETS     │         [1920×1080]  [16:9 ▾]  [fit]       │ BACKGROUND         │
│ LYRICS     │                                            │ TEXT / LYRICS      │
│ AUTO       │                                            │ MODULATION         │
│            │                                            │ LAYERS             │
├────────────┴────────────────────────────────────────────┴────────────────────┤
│ ⏮ ▶ ⏭   00:42.13 / 03:58.00   🔊───   [zoom ──●──]        ↑ Upload Audio     │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Audio      ▁▃▅▇▅▃▁▃▅▇▅▃▁  (beat grid ticks)                               │ │
│ │ ▸ stems    drums / bass / vocals / other  (expandable)                    │ │
│ │ Visualizer ████████████████████████                                       │ │
│ │ Background ██████████████████████████████                                 │ │
│ │ Lyrics     ▭ line ▭ line ▭▭ line ▭  line                                  │ │
│ │ Text       ▭▭▭                                                            │ │
│ │ Automation ◆────◆──────◆                                                  │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

Panels are resizable and collapsible; layout persists per project and as a global default.
A **focus mode** hides both side rails for previewing at size.

---

## 2. Canvas preview

- **Aspect switcher** — flip between the project's target aspects instantly (PROJECT.md §8.11). The active aspect determines which per-aspect overrides editing writes to, and this must be *unmissable* in the UI: an aspect badge beside the resolution, and an accent-coloured border when editing a non-base aspect. Editing the wrong aspect without noticing is the most likely confusion this feature creates.
- **Quality control** — preview scale (25/50/75/100%) plus an auto mode that drops resolution while scrubbing and restores when idle. Current effective resolution always shown.
- **Safe-area guides** per platform, toggleable.
- **On-canvas manipulation** — selected layer shows transform handles: move, scale (corner, with modifier for uniform/from-centre), rotate, anchor point. Snapping to canvas centre, thirds, edges and other layers' edges, with alignment guides.
- **Overlays**: grid, rule-of-thirds, layer bounds, title-safe.
- **Before/after** — hold a key to bypass all effects on the selected layer, or globally.
- **Fit / 100% / zoom**, pan with space-drag.
- **Dropped-frame indicator** during playback (export-spec §3) with a tooltip saying export quality is unaffected.

---

## 3. Timeline

Canvas-drawn, not DOM — thousands of keyframes and waveform samples will kill a DOM timeline.

**Tracks:** Audio (with expandable per-stem waveforms) · one row per layer, grouped · Lyrics ·
Text · Automation (expands into per-parameter lanes) · Markers.

**Interactions:**
- Zoom (scroll/pinch, zoom-to-selection, fit-project) and horizontal pan; playhead-anchored zoom.
- Drag layer blocks to change time range; resize edges; ripple-move with a modifier.
- **Snapping** to: playhead, beat grid (with subdivision selector), section boundaries, markers, other blocks, vocal onsets. Hold a modifier to disable temporarily.
- Multi-select with marquee and shift-click; group nudge by keyboard.
- Right-click context menus per track type.
- **Markers**: named, coloured, added at the playhead, snap targets, and used as render-range bounds.
- **Loop region** for reviewing one section repeatedly — the way you actually check a drop.

**Waveform rendering:** peaks precomputed at multiple zoom levels (mipmapped peak pyramid),
cached with the analysis (PROJECT.md M33). Beat grid drawn as ticks with downbeats emphasised.
The stem rows are what make lyric and drum-driven work precise.

---

## 4. Inspector

Generated from module schemas (module-spec §13). Fixed sections above the generated part:

1. **Layer header** — name (inline rename), type, enable/solo/lock, blend mode, opacity.
2. **Transform** — position, scale, rotation, anchor, with per-aspect override indicators.
3. **Module parameters** — generated, grouped, collapsible, with advanced disclosure.
4. **Effects** — ordered chain; add/remove/reorder by drag; per-effect bypass, solo and collapse; each effect's params generated the same way.
5. **Modulations** — bindings targeting this layer, with live values (modulation-spec §10).

**Every control**: right-click for Add modulation / Add keyframe / Copy / Paste / Reset to default /
Reveal in matrix. Modulated parameters show the live resolved value as a moving indicator against
the base handle; overridden-per-aspect parameters show a badge with reset-to-base.

**Multi-select editing**: selecting several layers shows shared parameters; edits apply to all,
with mixed values shown as such rather than as a false single value.

---

## 5. Left rail

**Presets** — browsable library with animated thumbnails, tags, search, favourites; project-level and layer-level; apply, or apply-partially (style only / modulations only).

**Audio** — file, duration, waveform, **trim in/out and fades** (PROJECT.md §8.10), lead-in/out padding, BPM (detected, with tap-tempo and offset correction), **stem status** with per-stem progress, solo buttons and re-run controls.

**Assets** — background image/video, quick colours, random background from the local pool, logo/watermark, fonts. Drag-drop anywhere. Shows which assets are missing, with relink.

**Lyrics** — the lyrics editor (lyrics-spec §5): text entry/import, tap-to-sync, alignment, validation checklist.

**Auto** — analyse, template picker with affinity scores, Generate, **Surprise me** with per-aspect locks and the history strip, and the **decision log** in plain language (auto-director-spec §8).

---

## 6. Modulation matrix panel

The anti-spaghetti view (modulation-spec §10): all bindings, grouped by source or target,
each with a source sparkline, enable/solo/bypass, amount, order, and jump-to-parameter.
Filter by layer or source. Bulk enable/disable. Dead-binding warnings shown inline.

---

## 7. Export dialog & queue

**Dialog:** preset picker (YouTube 1080p60 / 4K60 / Shorts / Square / Custom), then resolution,
fps, codec, quality, range (full / in-out / markers), output path, and toggles for supersampling,
motion blur and multi-aspect. Shows **estimated file size and estimated render time** from
measured throughput, plus a free-space check (export-spec §14).

**Queue:** job list with status, progress, per-job cancel, reorder, and "shutdown when done".
Completed jobs link to the output file and its render report. Failed jobs show the parsed cause
and a "copy diagnostics" action.

**During render:** frames done, fps, ETA (windowed), live thumbnail, pause/resume, cancel.

---

## 8. First-run & setup

The one flow that runs on a machine I'll never see (PROJECT.md §14), so it must explain itself:
- Welcome → tier selection (core / stems / lyrics / extras) with **sizes and a running total**.
- Per-artefact progress, resumable, with a clear log; failures name the artefact and offer retry/skip.
- Post-setup environment check: GPU, driver, CUDA, encoders — displayed as a readable report, not a log dump.
- Repair/verify entry point in Settings, re-runnable at any time.
- If a feature is unavailable (no stems installed), the UI says so *where the feature would be*, with a one-click fix — not a generic error later.

---

## 9. Keyboard

| | |
|---|---|
| Space / K | Play-pause |
| J / L | Back / forward, tap for speed |
| ← → | Frame step · with modifier: second step |
| Home / End | Start / end |
| I / O | Set range in / out |
| M | Add marker |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+D | Duplicate layer |
| S / A / L | Solo / mute / lock selected layer |
| T | Tap (lyrics sync, tempo) |
| F | Fit timeline · Shift+F fit canvas |
| Ctrl+E | Export dialog |
| \` | Before/after bypass (hold) |
| Del | Delete selection |

Remappable, with a shortcut reference in Settings.

---

## 10. State, undo, autosave

- **Command pattern for every mutation**: description, apply, revert, and a merge rule (dragging a slider coalesces into one undo entry rather than two hundred).
- Undo history is bounded, labelled, and browsable — "undo 12 steps" beats pressing Ctrl+Z and hoping.
- **Autosave** on an interval and before risky operations (apply preset, auto-generate, re-align lyrics), into a rolling set of recovery files.
- **Crash recovery** offers the recovered state on next launch, with a timestamp and a diff summary of what it contains.
- Selection and panel state are UI-only and never enter undo history — undoing a selection change is maddening.

---

## 11. Feedback & errors

- **Non-blocking toasts** for background events (stems finished, render complete), with actions.
- **Inline problem surfaces**: a layer with a shader error shows it in the inspector with the source line; a missing font shows on the text layer; a broken asset shows on the asset.
- **A status strip** for long-running background work — stem separation, alignment, analysis — with progress and cancel, always visible rather than hidden in a dialog.
- **Never a raw stack trace.** Errors state what failed, what it means, and what to do; diagnostics are one click away for the cases where the detail is wanted (PROJECT.md M34).

---

## 12. Visual design

- Dark, near-neutral chrome; the canvas is the only saturated thing on screen. A colourful UI around colourful output makes judging colour impossible.
- Compact density by default, with a comfortable option.
- Accent colour used only for active state and the play head.
- Numeric fields are drag-scrubbable and accept typed values and simple expressions (`0.5*2`).
- Sliders show default position as a tick, so "what was it originally" is always visible.
- Respects reduced-motion preferences for UI animation.

---

## 13. UI performance

- The preview renders in its own loop, decoupled from React; parameter changes write to the engine's state directly and only notify React for display values, throttled. Re-rendering a React tree per frame is the standard way these tools become sluggish.
- Timeline drawing is canvas-based, dirty-rect where practical, and virtualised by visible time range.
- Heavy panels (preset browser thumbnails, matrix sparklines) render lazily and pause when hidden.
- Target: 60 fps UI even while the preview runs at a lower rate; the UI must never feel as heavy as the render.

---

## 14. Open questions — resolved

Settled in [decisions.md](decisions.md):
- **Layer groups: in v1** (D3 → M38). The timeline shows nesting; the inspector shows group transform/opacity/effects.
- **Aspect switcher: implicit editing**, with an unmissable badge and border plus an explicit "edit base" toggle (D44).
- **Preset thumbnails: pre-rendered on save**; live preview-with-your-audio is a later refinement (D45).
- **Auto-director: offered on import, panel always available** (D9).
- **Node-graph view and multi-window: Could-have** (D46, D47).

---

## 15. Dependencies

- **[module-spec.md](module-spec.md) §13** — inspector generation rules.
- **[modulation-spec.md](modulation-spec.md) §10** — slider affordances, matrix panel, source monitor.
- **[lyrics-spec.md](lyrics-spec.md) §5** — lyrics editor and timeline track.
- **[auto-director-spec.md](auto-director-spec.md) §9** — Auto panel, reroll locks, decision log.
- **[export-spec.md](export-spec.md) §12–13** — export dialog, queue, progress semantics.
- **PROJECT.md §8.12** — preview clock; §8.16 settings; M33/M34 cache and diagnostics surfaces.
