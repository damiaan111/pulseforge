// What a chosen file is, from its name alone. Pure, so the studio can ask before it does any work.

/** Containers the import dialog offers for their sound. A file here may also have a picture. */
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpg', 'mpeg', 'wmv'] as const;

/** What the import dialog lists as audio. */
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aac', 'aiff'] as const;

/** The audio formats the preview's `<audio>` element plays from a Blob. AIFF is not one of them. */
const PLAYABLE_EXTENSIONS: readonly string[] = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aac'];

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isVideoFile(path: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/**
 * Whether the sound has to be taken out into a working file before the project can use it. The
 * analysis and the export read anything FFmpeg reads, but the preview plays a Blob, and Chromium
 * refuses most video containers (and some audio ones) there. One rule for every video file, even
 * an MP4 this Chromium would play: whether a project's preview has sound must not depend on the codec.
 */
export function needsWorkingAudio(path: string): boolean {
  return !PLAYABLE_EXTENSIONS.includes(extensionOf(path));
}
