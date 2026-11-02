// The size the preview actually renders at: the project's canvas times the quality scale, and in
// draft mode (S18) capped so its long side is at most DRAFT_LONG_SIDE. One function, so the
// renderer, the size badge and the performance HUD's estimates cannot disagree.

/** Draft mode's fixed low resolution: 640 px on the long side (640×360 for 16:9, 360×640 vertical). */
export const DRAFT_LONG_SIDE = 640;

/** Even dimensions keep the preview comparable with the export path, which cannot encode an odd one. */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function previewScaleFor(canvas: { readonly width: number; readonly height: number }, scale: number, draft: boolean): number {
  const clamped = Math.min(1, Math.max(0.25, scale));
  if (!draft) return clamped;
  return Math.min(clamped, DRAFT_LONG_SIDE / Math.max(canvas.width, canvas.height));
}

export function previewRenderSize(canvas: { readonly width: number; readonly height: number }, scale: number, draft: boolean): { width: number; height: number } {
  const s = previewScaleFor(canvas, scale, draft);
  return s === 1 ? { width: canvas.width, height: canvas.height } : { width: even(canvas.width * s), height: even(canvas.height * s) };
}
