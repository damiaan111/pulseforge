# Data Formats, Versioning & Analysis Cache — detailed specification

> Closes audit gaps on **M1** (project schema versioning & migration) and **M4** (AnalysisCache
> format and contract). Companion to [PROJECT.md](../PROJECT.md) §6–7 and
> [module-spec.md](module-spec.md) §9.
> Design spec, not implementation. Status: draft for review. Last updated: 2026-09-14.

---

## 0. Why this needs its own document

Two long-lived promises depend on getting these formats right:

1. **"A project from a year ago still opens and still renders the same."** That's a migration problem, and migration is only tractable if the format was designed for it from version 1.
2. **"Analysis runs once per track, ever."** That's a cache-invalidation problem, and cache invalidation is only safe if the cache key captures everything that could change the result.

Both are cheap now and expensive later. Neither is interesting work, and skipping them is how
tools end up with a folder of projects that no longer open.

---

## 1. Project file (`.pvproj`)

### 1.1 Format
- **JSON, UTF-8, pretty-printed with stable key order.** Text and diffable on purpose: it survives partial corruption, can be inspected and hand-fixed, and works with git. Binary would be smaller and much worse to live with.
- Large embedded payloads (glyph caches, thumbnails, waveform peaks) are **never** in the project file; they're cache artefacts (§4).
- Target size: well under 1 MB for a complex project.

### 1.2 Identity & references
```
audio:  { path, hash, durationTicks, … }
assets: [ { id, role, path, hash, size, relinkable } ]
```
- Assets are referenced by **path plus content hash**. Path finds it; hash verifies it's the same file.
- Paths stored **relative to the project file when possible**, absolute otherwise, so moving a project folder doesn't break it.
- On load: path missing → offer relink; hash mismatch → warn that the file changed (a re-encoded background will look different), never silently accept.
- **"Collect files"** (PROJECT.md S19) rewrites everything to a self-contained folder.

### 1.3 Time representation
- All times are **integer ticks**, not floats: **1 tick = 1/48000 s** (D10), matching the audio sample rate, so sample-accurate audio positions are exactly representable, as are frame boundaries at integer fps that divide 48000. NTSC rates (59.94, 29.97) are not tick-exact; frame boundaries derive from the rational fps and round with `floor` when stored as ticks (export-spec §2).
- Floats for time invite the same drift discussed in export-spec §2, plus JSON round-trip noise (`0.1 + 0.2`). Integers make equality comparisons and snapping exact.
- `fps` stored as a rational `{ num, den }`.

### 1.4 Identifiers
- Every layer, effect, binding, keyframe and lyric line has an opaque id, generated once (ULID-style: sortable, collision-free), **never reused** after deletion.
- Ids are the anchor for modulation targets, masks, groups and presets (module-spec §4).

---

## 2. Versioning & migration

### 2.1 Three independent version numbers
| Version | Scope | Bumped when |
|---|---|---|
| `schemaVersion` | project document structure | A structural change to the document |
| `paramsSchemaVersion` | per module instance | That module's parameters change meaning (module-spec §9) |
| `appVersion` | recorded, not enforced | Always — provenance for the render report |

Separating them matters: a module's parameter change shouldn't force a document migration, and a
document change shouldn't invalidate every module.

### 2.2 Migration rules
- Migrations are an **ordered chain of pure functions**, `v(n) → v(n+1)`. Opening a v3 document in a v7 app runs 3→4→5→6→7. Never a single "handle all old versions" branch, which becomes unmaintainable by about version four.
- Every migration is **covered by a fixture test**: a real project file at the old version, committed, with the expected result. Fixtures accumulate; they are the actual guarantee.
- **Migration is non-destructive**: the original file is backed up as `name.v3.bak` before the first save in the new format.
- **Forward compatibility**: opening a *newer* document than the app understands is refused with a clear message, not a partial parse. Half-loading a future format and then saving over it destroys data.
- **Unknown fields are preserved**, not stripped. A project touched by a newer version and saved by an older one should not lose what the older one didn't understand.

### 2.3 What counts as a breaking change
Renaming or repurposing a field, changing units, changing default semantics, changing the meaning
of an id. Adding optional fields is not breaking. The test: *would an old file interpreted by the
new code render differently?* If yes, it needs a migration — a render from last year must still
produce the same frames (PROJECT.md §15).

---

## 3. Presets & templates

- Presets (module-spec §10) and templates (auto-director-spec §4) carry their own `formatVersion` and follow the same migration discipline.
- Both store **only deltas from defaults**, so improving a default improves existing presets rather than being frozen out of them.
- Both are single files in known folders, hand-editable, git-friendly.

---

## 4. AnalysisCache

### 4.1 Purpose & shape
Precomputed per-time-step audio features for the mix and every stem. Read by the modulation
system, the timeline, the auto-director and the lyrics validator.

```
analysis/<audioHash>/<settingsHash>/
  meta.json            // versions, rates, ranges, stats, stem list
  mix.bin              // interleaved feature tracks
  drums.bin  bass.bin  vocals.bin  other.bin
  beatgrid.json        // beat times, downbeats, bpm curve, confidence
  sections.json        // boundaries, labels, energy curve
  peaks/               // multi-resolution waveform peaks for the timeline
  derived/             // envelope/quantised tracks (modulation-spec §5)
```

### 4.2 The binary format
- **Float32 arrays, little-endian, fixed analysis rate (240 Hz), one file per source**, with a small header declaring rate, length, and which feature tracks are present in which order.
- Why binary: a 5-minute track at 240 Hz with ~20 feature tracks per source across 5 sources is ~7.2 M floats (72 000 samples × 20 × 5). JSON would be ~150 MB of text and slow to parse; binary is ~29 MB and memory-maps.
- Spectrum frames (the full FFT bins) are stored separately and optionally — they're the bulk of the data and only the spectrogram visualizer needs them at full resolution.

### 4.3 The cache key — what must be in it
```
audioHash     sha256 of the decoded PCM (not the file: re-encoding the same
              audio to a different container must hit the same cache)
settingsHash  fftSize, hop, window, band definitions, onset sensitivity,
              stem model id, analysis algorithm version
```
- **`analysisVersion` is part of `settingsHash`.** Changing the onset algorithm must invalidate old caches; forgetting this is how stale results survive a bug fix and produce "it's still doing the old thing" reports that waste an afternoon.
- Band definitions are in the key because they change the band tracks — but a band *rename* must not, so the hash covers semantics, not labels.

### 4.4 Read contract
- Values are sampled at 240 Hz and **linearly interpolated** on read, so any fps works and the same `t` yields the same value in preview and export.
- Reads clamp at the ends rather than extrapolating.
- Sources are addressed as `(stem, feature)` with a stable enumeration; an unknown pairing is a schema error, not a silent zero.
- **Partial availability is explicit**: the mix analysis completes in seconds while stems take minutes, so the cache exposes per-source readiness and the UI degrades visibly rather than returning zeros that look like silence (PROJECT.md M5).

### 4.5 Invalidation & lifecycle
- Invalidated by: audio change, analysis settings change, `analysisVersion` bump, stem model change.
- Never invalidated by: trim, fades, lead-in (those are timeline-time mappings — PROJECT.md §8.10), project edits, resolution or fps changes.
- Rebuildable by definition: deleting the whole cache costs time only (PROJECT.md M33).
- Derived tracks (envelopes) are second-level cache, keyed by their binding parameters, evicted independently.

---

## 5. Render reports & decision logs

Both are artefacts written beside their outputs, both versioned JSON with a stable schema:
- **Render report** (export-spec §15) — everything needed to reproduce a render.
- **Decision log** (auto-director-spec §8) — everything the director chose and why.

They're specified as *data*, not as log text, so they can be diffed between two renders. "What
changed between the version I liked and this one" is otherwise unanswerable.

---

## 6. Settings & app state

- User settings (PROJECT.md §8.16) in a versioned JSON file in the user data directory, **never in the repo**, migrated on the same discipline.
- `vendor.lock.json` (PROJECT.md §3) records exactly which artefacts are installed, with hashes — the provenance record for offline reproducibility.
- Window layout, recent files and panel state in a separate file, because losing them is harmless and they change constantly.

---

## 7. Open questions — resolved

Settled in [decisions.md](decisions.md):
- **Tick rate**: 1/48000 s integer ticks (D10). A 4-minute track is ~11.5 M ticks — safe in float64-backed JSON; never store ticks in 32-bit integers.
- **Spectrum storage**: 256 log-spaced bins cached; full FFT recomputed on demand (D12).
- **Project thumbnail**: cached, not embedded (D13).
- **Analysis rate**: 240 Hz (D11).
- **Multiple audio sources**: no speculative room in the format; a future array is a normal migration (D14).

---

## 8. Dependencies

- **[module-spec.md](module-spec.md) §9–10** — module-level versioning and presets.
- **[modulation-spec.md](modulation-spec.md) §3, §5** — source reads and derived envelope tracks.
- **[export-spec.md](export-spec.md) §2, §15** — rational fps, tick arithmetic, render reports.
- **PROJECT.md §8.10** — timeline-time mapping; §8.14 cache management; §15 project compatibility.
