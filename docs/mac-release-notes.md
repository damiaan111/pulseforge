## Pulseforge for Mac (Apple Silicon) — first preview

The Mac build of Pulseforge 1.1.0, for Macs with an M-series chip (M1 or newer) on **macOS 14 or newer**. It is
a preview: it was built and checked on GitHub's Apple Silicon machines, and has not yet been used by a person on
a real Mac. The Windows release is still the main one.

### Install

1. Download **Pulseforge-1.1.0-mac-arm64.dmg** below and open it.
2. Drag **Pulseforge** onto **Applications**.
3. Open it from Applications. The app is not signed with an Apple Developer ID, so macOS stops it the first
   time: open **System Settings → Privacy & Security**, scroll to *"Pulseforge" was blocked*, and choose
   **Open Anyway**. After that it opens normally.

The first start offers the components, as on Windows. They go to
`~/Library/Application Support/Pulseforge/Data` unless you choose another folder.

### What is different on a Mac

- **Video export** uses VideoToolbox, Apple's hardware encoder: H.264 and 10-bit HEVC. There is no AV1.
- **Stem separation** runs on the GPU through Metal.
- **Transcription** (WhisperX) runs on the CPU: its engine has no Metal support. Expect a few minutes per song.
- Everything else, MilkDrop, the auto-director, lyrics, keyframes and the rest, is the same program.

### Known

- The quality setting for VideoToolbox is a first mapping from NVENC's, not yet measured.
- "Shut down when done" asks for permission to control System Events the first time.
- If something goes wrong: **Settings → Logs → Copy diagnostics**.
