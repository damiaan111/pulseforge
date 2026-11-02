# Changelog

## 1.1.2

- **Fixed: 1.1.0 and 1.1.1 did not start** on any PC but the one they were built on: the studio loaded a build tool the
  installer does not include. Exporting from an installed copy would have failed too, as the export renderer was built on the
  fly. It is now built with the app, and the build refuses anything that would need a tool at runtime.
- **Check for updates** in Settings: asks GitHub only when you press it, shows what is new, and installs the update over
  this version after checking its SHA-256. Your components, projects and settings stay.
- Fixed: a data folder with spaces on another drive broke installing and verifying the Python components.

## 1.1.1

- Fixed: the preview could turn white after many MilkDrop layers were removed or many Surprise Me rolls. Each
  MilkDrop layer holds a WebGL context, and the engine kept them all until Chromium dropped the preview's own.

## 1.1.0

The first release with a Windows installer.

- **ISF shaders:** drop a `.fs` file in the modules folder, or add Vidvox's library as a component. Files
  that cannot run are listed with the reason.
- **Titles** can run vertically, grow a solid 3D side that follows the beat, and draw emoji in colour
  (with the Colour emoji component).
- **A real Windows app:** `Pulseforge-Setup-1.1.0.exe` installs Pulseforge with a Start menu and desktop shortcut, and
  `.pvproj` files open in it. Components live outside the program, in a folder you can choose, so updates leave them alone.
- **Remove optional models and libraries** from the app, and install them again whenever you like.
- **Auto:** colours from an image or the song's cover, the musical key, palette shifts at a chorus, Extract as template,
  and arrangement curves to keyframes.
- **MIDI files** drive parameters, note by note. **Combine audio files** into one track. **A video file** works as audio,
  and can stay as the background. **A/B render** puts two versions side by side. A read-only **node view** of the project.
- Thai breaks between words; the MilkDrop preset field is a searchable list; new visuals stay under the words.
- **File size** in the export dialog and `--quality`: Best, Balanced (about half on a busy picture) or Small (about a third).
- **After a crash, the studio comes back and offers your work.** Before, the autosave was on disk but the offer never appeared.
  A second crash within a minute asks what to do rather than leaving a blank window. Crash dumps stay on your disk.
- The preview comes back after a graphics driver reset.
- 23 MilkDrop presets with a shader that cannot run now fall back for that stage and say so. Auto no longer picks them.
- **Changed:** a Shadertoy effect that reads its input now sees the right colours, where the picture came out too dark. Projects
  with such an effect will look different.
- Auto remembers the picture its colours came from, ignores a key it is unsure of, and Lyric Focus and Cinematic Particles follow the
  key. Neon Grid and Cinematic Particles shift colour at the chorus.
- Uninstalling removes the `.pvproj` association. The Python sidecar gets three minutes to start.

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
- **New visuals stay under the words,** so turning one off and on again no longer hides the lyrics. The layer
  list gained **To bottom**.
- **With lyrics, Auto now reaches for MilkDrop Lyric:** the words sit on a plate and stay readable over any preset.
- Fixed: keys acting on the studio behind an open dialog; a MilkDrop click stacking a second layer; panels running
  off the left rail; render scratch folders piling up. A crashed window reloads and offers the autosave.
- Fixed: the beat grid drifting off the music over a song; long lyric lines cut off in Lyric Focus; a sung "I" or
  "a" costing its whole line the word timing.

Stems and lyrics need an NVIDIA card with driver 580 or newer. See `docs/STATUS.md` for what has and has not
been verified on real hardware.
