// Export presets (PROJECT.md §8.8, ui-spec §7): the shapes and codecs a render is offered in.
//
// Pure data, imported by both the studio's export dialog and the main process's queue runner, so
// "what the dialog said" and "what was rendered" come from one table.
//
// Every size is divisible by 4 in width and 2 in height, so the GPU NV12 path (D39) applies to
// all the 8-bit presets rather than silently falling back to the slower CPU conversion.

import type { VideoCodec } from './ffmpeg-args.ts';

export interface ExportPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly codec: VideoCodec;
  /** Null renders at the project's own canvas size. */
  readonly size: { readonly width: number; readonly height: number } | null;
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: 'youtube-1080p', label: 'YouTube 1080p', description: '1920×1080, H.264 8-bit', codec: 'h264', size: { width: 1920, height: 1080 } },
  { id: 'youtube-4k', label: 'YouTube 4K', description: '3840×2160, H.264 8-bit', codec: 'h264', size: { width: 3840, height: 2160 } },
  { id: 'shorts', label: 'Shorts / Reels', description: '1080×1920 vertical, H.264 8-bit', codec: 'h264', size: { width: 1080, height: 1920 } },
  { id: 'square', label: 'Square', description: '1080×1080, H.264 8-bit', codec: 'h264', size: { width: 1080, height: 1080 } },
  { id: 'master-hevc10', label: 'Master (HEVC 10-bit)', description: 'Project size, HEVC 10-bit — for archiving and re-editing', codec: 'hevc', size: null },
  { id: 'project-h264', label: 'Project size', description: 'Project size, H.264 8-bit', codec: 'h264', size: null },
];

export function findExportPreset(id: string): ExportPreset | undefined {
  return EXPORT_PRESETS.find((preset) => preset.id === id);
}

/** The canvas a preset renders at, for a project of the given size. */
export function presetCanvas(preset: ExportPreset, project: { readonly width: number; readonly height: number }): { width: number; height: number } {
  return preset.size === null ? { width: project.width, height: project.height } : { ...preset.size };
}

/** `My Song — youtube-1080p.mp4`, with characters Windows refuses in a filename removed. */
export function suggestedOutputName(projectName: string, preset: ExportPreset): string {
  const clean = [...projectName].filter((ch) => ch.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(ch)).join('').trim();
  return `${clean === '' ? 'Untitled' : clean} - ${preset.id}.mp4`;
}
