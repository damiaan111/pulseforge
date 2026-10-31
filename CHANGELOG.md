# Changelog

## 1.0.0

The first version meant for other people.

- **MilkDrop:** about 1,750 community visuals through Butterchurn, as an optional download, rendering
  byte-identically from one run to the next.
- **The auto-director picks MilkDrop presets for the track.** Every preset was rendered and measured, so busy
  songs get busy pictures, and the ones that stay black or strobe are never chosen. Three new templates.
- **Exports work on any PC:** H.264 encodes on the CPU where NVENC is not available, at about half the
  speed and a slightly larger file for the same quality.
- **The generated presets are gone.** Save your own, or start from MilkDrop.
- **A launcher:** `Pulseforge.cmd` downloads what it needs, and you choose the components. MIT licence.
- Fixed: renders that stalled for two minutes at random, when two started as the app rebuilt its render page.
- **Rename a project** by clicking its name in the top bar.
- **With lyrics, Auto now reaches for MilkDrop Lyric:** the words sit on a plate and stay readable over any preset.
- Fixed: keys acting on the studio behind an open dialog; a MilkDrop click stacking a second layer; panels running
  off the left rail; render scratch folders piling up. A crashed window reloads and offers the autosave.
- Fixed: the beat grid drifting off the music over a song; long lyric lines cut off in Lyric Focus; a sung "I" or
  "a" costing its whole line the word timing.

Stems and lyrics need an NVIDIA card with driver 580 or newer. See `docs/STATUS.md` for what has and has not
been verified on real hardware.
