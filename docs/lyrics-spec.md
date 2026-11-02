# Lyrics & Karaoke System — detailed specification

> Companion to [PROJECT.md](../PROJECT.md) §8.7, §8.13, and [modulation-spec.md](modulation-spec.md) §2.4.
> Design spec, not implementation. Status: draft for review. Last updated: 2026-09-14.

---

## 0. Scope and the honest constraint

Lyrics on screen, timed to the music, with word-level karaoke highlighting.

**The constraint, stated plainly:** perfect automatic timing of sung vocals does not exist.
Forced aligners are trained on speech; singing stretches vowels, slides between notes, and sits
under instrumentation. WhisperX on an isolated vocal stem gets *most* lines close and some words
wrong — good enough to be a huge time-saver, never good enough to ship unchecked.

So the system is built around a specific idea: **the machine produces a draft, the human corrects
it, and correcting must be fast.** Every design decision below serves the correction workflow —
because that's where the actual minutes go, not in the alignment itself.

Three input routes, all landing in the same editable structure:

| Route | Effort | Accuracy | When |
|---|---|---|---|
| **Import `.lrc`/`.srt`** | seconds | as good as the source | Timings already exist |
| **Tap-to-sync** | ~2× track length | line-level, reliable | The guaranteed path |
| **WhisperX auto-draft** | ~1 min compute | word-level, needs correction | The fast path |

---

## 1. Data model

```
LyricsDocument {
  language        "en" | …            // drives the alignment model
  source          "manual" | "import" | "aligned"
  lines [
    Line {
      id
      text                            // the authoritative string
      startTicks, endTicks            // timeline time (PROJECT.md §8.10)
      words [ Word { id, text, startTicks, endTicks, confidence? } ]
      role      "lead" | "backing" | "adlib" | "instrumental-note"
      style?    overrides             // per-line style deviation
      confidence?                     // aggregate, from alignment
      locked    bool                  // human-verified: never touched by re-alignment
    }
  ]
  style           LyricStyle          // §7
  karaoke         KaraokeStyle        // §6
  layout          LayoutSettings      // §5
}
```

Design decisions embedded here:

- **Words are optional.** A line with no word timings still renders and still karaoke-fills, by interpolating evenly across the line (§6.4). Word timing is an upgrade, never a prerequisite.
- **Timeline ticks, not audio-file seconds**, so trim and lead-in padding can change without touching lyric timings.
- **`locked` is load-bearing.** Once you've hand-corrected a line, re-running alignment must not silently undo your work. Re-alignment fills unlocked lines only.
- **`role`** separates lead vocals from backing and ad-libs, which matters because they usually want different styling and often overlap in time.

---

## 2. Text input & preparation

### 2.1 Entry
- Paste plain text, type directly, or import `.lrc` (line), enhanced `.lrc` (A2 word tags), `.srt`, `.vtt`, `.ttml`.
- Drag-drop a file onto the lyrics panel.
- Auto-transcribe from the vocal stem (§4) when no text exists at all.

### 2.2 Line splitting
Blank-line and newline-respecting by default, with assisted splitting:
- Split long lines at punctuation or at a target character count, preserving phrasing.
- Merge/split any line with one keystroke during editing.
- Detect and strip common annotations — `[Verse 1]`, `[Chorus]`, `(x2)` — converting them to **section markers** rather than displayed text. Pasting lyrics from the web is the normal case, and those brackets are always in there.

### 2.3 Tokenisation
- Words split on whitespace; punctuation attaches to the preceding word so it never fills as a separate token.
- Hyphenated and elided forms (`don't`, `rock-'n'-roll`) stay single tokens.
- **Syllable splitting is not attempted.** Automatic syllabification is unreliable across languages and mostly unnecessary: sub-word karaoke fill interpolates smoothly within a word anyway (§6.4). A manual syllable split is available for the rare long melisma.

---

## 3. Tap-to-sync

The guaranteed path — no models, no dependencies, always works.

**Two-pass workflow:**
1. **Pass 1 — line starts.** Play the track (optionally at 0.75× or 0.5×, which does not change timing accuracy since taps are recorded in timeline time) and tap a key at the start of each line. The current and next lines are shown large, with the vocal stem waveform scrolling beneath.
2. **Pass 2 — optional refinement.** Tap word starts within a line, or set line ends. Most projects skip this and let interpolation handle words.

**Details that make it actually usable:**
- **Tap latency compensation.** Human tap latency is 80–150 ms and consistent per person. A calibration step (tap along to a click track, measure the mean offset) applies a per-user correction. Without it, every line lands late and needs nudging — which defeats the point.
- **Snap-to-onset**: a tap lands on the nearest vocal-stem onset within a small window, which is usually more accurate than the tap itself.
- **Undo one tap** with backspace, re-tap from any line, and tap only a selected range without disturbing the rest.
- **Punch-in**: select lines 12–18, play from 11, re-tap just those.
- Beat-grid snapping optional, off by default — vocals rarely land exactly on the grid, and forcing them there sounds worse than leaving them slightly loose.

---

## 4. Forced alignment (WhisperX)

Runs in the ML sidecar (PROJECT.md §3) **on the isolated vocal stem**, which is the single biggest
accuracy factor — aligners degrade badly on full mixes.

**Two modes:**
- **Align** (text provided) — the accurate mode. Known text, find the timings.
- **Transcribe + align** (no text) — produces both, with transcription errors expected; useful as a starting point for a track whose lyrics you don't have written down.

**Output handling:**
- Word timings land with per-word **confidence**, surfaced as a heat overlay in the editor so attention goes to the suspect 10% rather than a full manual review.
- Alignment fills **unlocked lines only**; re-running after corrections never destroys them.
- A **sanity pass** rejects obviously broken output — words out of order, zero-length, or outside detected vocal segments — and marks those lines for manual timing instead of writing nonsense.
- Language selection drives which wav2vec2 model is fetched (PROJECT.md §3); an unsupported language falls back to line-level tap-to-sync with a clear message.

**Expected accuracy, stated so it isn't oversold:** clean, forward-mixed vocals usually land within
~50 ms on most words. Heavy effects, layered harmonies, rapid delivery and long held notes are
where it breaks — and those are exactly the places the confidence heat should point you.

---

## 5. Timeline & editing UX

- **Lyrics are a first-class timeline track.** Lines are draggable blocks; edges resize; multi-select and nudge by keyboard.
- The track expands to show **word blocks** within each line.
- **The vocal stem waveform renders behind the lyric track** — the feature that makes manual correction fast, because you can see where singing starts instead of guessing.
- Snapping: to vocal onsets (default), to the beat grid (optional), to adjacent line edges.
- **Ripple mode**: shift a line and optionally move everything after it — the fix when the whole second half is uniformly late.
- **Karaoke scrub preview**: dragging the playhead shows the fill state live, so timing is verified by eye rather than by repeated playback.
- Keyboard-first: next/previous line, set in, set out, nudge ±10/100 ms, lock line, split, merge.

---

## 6. Karaoke rendering

### 6.1 Fill modes
| Mode | Behaviour |
|---|---|
| `wipe` | Colour sweeps left→right across the active word — the classic |
| `wordSwap` | The whole word switches colour at its start |
| `wordPop` | Word scales/brightens briefly as it starts, then settles |
| `fillStroke` | Outline fills with colour, keeping a constant outline |
| `gradientSweep` | A soft gradient edge travels through the line rather than a hard boundary |
| `bouncingBall` | A marker travels above the line, landing on each word |
| `none` | Static display, line-timed only |

### 6.2 Sweep geometry
The wipe is a **horizontal mask over the rendered line texture**, driven by fill progress. Because
text rasterisation produces per-word bounding boxes (PROJECT.md M32), the mask boundary can be
computed exactly, including a configurable soft edge (0 = hard boundary, higher = feathered).

### 6.3 Line window
- `linesVisible`: current only, current + next, or a rolling window of N.
- Next-line preview at reduced opacity — the thing that makes a lyric video singable rather than just decorative.
- Line advance: cut, crossfade, or scroll.

### 6.4 Progress calculation
```
word present:     progress = (t - word.start) / (word.end - word.start)
word absent:      distribute line duration across words weighted by character count
gap between words: hold at 1.0 for the completed word (don't fill into silence)
```
Character-weighted distribution is noticeably better than equal distribution — "I" and
"everything" should not take the same time — and it costs one line of arithmetic.

### 6.5 Lead-in and hold-out
- `leadInMs` — line appears before it's sung (default ~500 ms, so there's time to read it).
- `holdOutMs` — line stays after it ends.
- **A lead-in longer than the gap to the previous line is clamped**, not overlapped, or lines stack on dense verses.

---

## 7. Styling

Everything is a schema-declared parameter (module-spec §3), so all of it is modulatable and
animatable, and the inspector generates itself.

**Typography:** font family/variant, size (canvas-relative), weight, letter spacing, line height,
case transform, max width, alignment, wrap behaviour.

**Colour:** `upcoming`, `active`, `sung` fills (each palette-linkable), stroke colour/width,
shadow, glow, gradient fills, background plate (colour, padding, corner radius, opacity, blur).

**Placement:** anchor + offset, per-aspect overrides (PROJECT.md §8.11) — vertical video almost
always wants lyrics higher and larger than landscape — and safe-area awareness.

**Per-line and per-role overrides:** backing vocals smaller and dimmer, ad-libs offset to one side.

**Entry/exit animations:** fade, slide (any direction), scale, blur-in, typewriter, per-word
stagger, with easing and duration, timed relative to line in/out.

**Legibility defaults that should be on by default:** a subtle shadow or plate behind text, and
contrast enforcement against the actual backdrop (auto-director-spec §7). Neon backgrounds and
thin bright type are a bad combination without one of them.

---

## 8. Integration points

**Modulation** (modulation-spec §2.4) exposes `lyricActive`, `lineProgress`, `wordActive`. The
`wordActive` impulse driving a small scale or glow bump on the text gives per-word emphasis that
reads as musical rather than mechanical. The `lyric dim` recipe — visualizer opacity multiplied
down while words are on screen — is the cheapest legibility win available.

**Auto-director** (auto-director-spec §5.4) places the lyrics slot with priority over decorative
layers, schedules title text to clear before the first vocal segment, and selects the *Lyric
Focus* template when vocal coverage is high and lyrics exist.

**Text engine** (PROJECT.md M32) supplies deterministic rasterisation and per-word metrics.
Karaoke is unimplementable without those metrics, which is why M32 is a must-have.

**Stems** supply the vocal waveform for editing, the alignment input, and `vocalSegments` for
validation.

---

## 9. Validation & QA

Run continuously, surfaced as a checklist in the lyrics panel — this is what catches the timing
error *before* a 20-minute 4K render rather than after:

| Check | Why |
|---|---|
| Lines overlapping in time | Usually a mis-tap; renders as garbled text |
| Line with no words sung under it (`vocalSegments`) | Timing drifted, or the line is in the wrong place |
| Vocal activity with no line assigned | A missing line — easy to skip a repeat |
| Line duration under ~250 ms or over ~15 s | Almost always an error |
| Reading speed above a threshold | Technically correct, practically unreadable |
| Word timings out of order or zero-length | Broken alignment output |
| Low-confidence cluster | Points at the region worth reviewing |
| Text overflowing the safe area at any target aspect | Catches vertical-export breakage early |
| Missing font | Would silently substitute and change the design |

---

## 10. Subtitle export

Burned-in rendering is the deliverable, but the timing data has value on its own:
- Export `.lrc` (line or enhanced word-level), `.srt`, `.vtt`, `.ass` (with basic karaoke `\k` tags).
- Optional soft-subtitle track muxed into the MP4 alongside burned-in lyrics.
- Round-trips: what's exported re-imports with the same timings.

---

## 11. Performance

- Line textures are rasterised once per (text, style, resolution) and cached; karaoke fill is a mask over the cached texture, not a re-rasterisation. Re-rasterising per frame would be the obvious naive approach and is far too slow at 4K.
- Only lines within the visible window plus a small lookahead are rasterised.
- The cache is keyed and evicted with the other render caches (PROJECT.md M33).

---

## 12. Open questions — resolved

Settled in [decisions.md](decisions.md):
- **Tap latency calibration**: global, stored in settings, re-calibratable (D33).
- **Alignment auto-run**: explicit action, offered via toast when it becomes possible (D34).
- **Duets / overlapping lines**: `role` on a single track in v1; a second track is a Could-have (D35).
- **Manual syllable splitting**: v1.x, Should (D36).
- **`.lrc` re-alignment**: offered, never forced (D37).
- **Per-word styling**: per-line overrides in v1; per-word emphasis via `wordActive` modulation; per-word styling is a Could-have (D38).

---

## 13. Dependencies

- **PROJECT.md M32** — deterministic text rasterisation with per-word metrics.
- **PROJECT.md M5** — vocal stem for editing reference, alignment input and validation.
- **PROJECT.md §3** — WhisperX and wav2vec2 models in the ML sidecar.
- **[module-spec.md](module-spec.md)** — the lyrics layer is a `text`-kind module; all styling is schema-declared.
- **[modulation-spec.md](modulation-spec.md) §2.4** — lyric sources.
- **[auto-director-spec.md](auto-director-spec.md) §5.4** — automatic placement and the Lyric Focus template.
