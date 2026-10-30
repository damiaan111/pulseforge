# Changelog

## 1.0.0

The first version meant for other people.

- **MilkDrop:** about 1,750 community visuals through Butterchurn, as an optional download, rendering
  byte-identically from one run to the next.
- **The auto-director picks MilkDrop presets for the track.** Every preset was rendered and measured, so busy
  songs get busy pictures, and the ones that stay black or strobe are never chosen. Three new templates.
- **Exports work on any PC:** H.264 encodes on the CPU where NVENC is not available.
- **The generated presets are gone.** Save your own, or start from MilkDrop.
- **A launcher:** `Pulseforge.cmd` downloads what it needs, and you choose the components. MIT licence.
- Fixed: renders that stalled for two minutes at random, when two started as the app rebuilt its render page.

Stems and lyrics need an NVIDIA card with driver 580 or newer. See `docs/STATUS.md` for what has and has not
been verified on real hardware.
