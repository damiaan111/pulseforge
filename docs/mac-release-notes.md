## Pulseforge for Mac (Apple Silicon) — preview

The Mac build of Pulseforge 1.1.2, for Macs with an M-series chip (M1 or newer) on **macOS 14 or newer**. It is a
preview: it is built and checked on GitHub's Apple Silicon machines, including the packaged app itself with a real
export, but it has not yet been used by a person on a real Mac. The Windows release is still the main one.

### Install

1. Download the **.dmg** below and open it.
2. Drag **Pulseforge** onto **Applications**.
3. Open it from Applications. The app is not signed with an Apple Developer ID, so macOS stops it the first time:
   open **System Settings → Privacy & Security**, scroll to *"Pulseforge" was blocked*, and choose **Open Anyway**.
   After that it opens normally.

The first start offers the components, as on Windows. They go to `~/Library/Application Support/Pulseforge/Data`
unless you choose another folder.

### Updates

**Settings → Check for updates** asks GitHub for a newer Mac build, only when you press it. Install downloads the
disk image, checks its SHA-256 and opens it; Pulseforge closes, and you drag the new one onto Applications.

### What is different on a Mac

- **Video export** uses VideoToolbox, Apple's hardware encoder: H.264 and 10-bit HEVC. There is no AV1.
- **Stem separation** runs on the GPU through Metal.
- **Transcription** (WhisperX) runs on the CPU: its engine has no Metal support. Expect a few minutes per song.
- A full menu bar, ⌘ shortcuts, and `.pvproj` files open from the Finder.

### Fixed since the first preview

- The packaged app could not start or export outside the build machine (the same fault as Windows 1.1.0 and 1.1.1).
- The preview could turn white after many MilkDrop layers were removed or many Surprise Me rolls.

### Known

- The quality setting for VideoToolbox is a first mapping from NVENC's, not yet measured.
- "Shut down when done" asks for permission to control System Events the first time.
- If something goes wrong: **Settings → Logs → Copy diagnostics**.
