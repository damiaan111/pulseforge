// Frame comparison for the golden set (export-spec §16).
//
// Two tolerance policies, and the difference matters:
//
//  - **Bit-exact** for repeat renders on the same machine. That *is* the determinism contract
//    (CLAUDE.md constraint 1), so a hash mismatch here is a real regression, never noise.
//  - **Perceptual** for cross-machine comparison. Frames rendered on a different GPU will not
//    match bit-for-bit — different drivers round filtering and interpolation differently — so a
//    perceptual score exists to catch gross breakage, not to enforce identity.
//
// The runner always checks the hash first and only falls back to these when it fails, so a
// passing run costs nothing and a failing one says *how* different, not just "different".

export interface FrameDifference {
  /** Structural similarity, 1.0 for identical images. */
  readonly ssim: number;
  /** Largest single-channel difference, 0–255. */
  readonly maxChannelDelta: number;
  /** Mean absolute difference across all channels, 0–255. */
  readonly meanAbsoluteError: number;
  /** Share of pixels differing by more than one code value. */
  readonly changedPixels: number;
}

function luma(pixels: Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i += 1) {
    const o = i * 4;
    out[i] = 0.2126 * (pixels[o] ?? 0) + 0.7152 * (pixels[o + 1] ?? 0) + 0.0722 * (pixels[o + 2] ?? 0);
  }
  return out;
}

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const WINDOW = 8;
const STRIDE = 4;

/** Mean SSIM over overlapping 8×8 windows of the luma channel. */
function ssim(a: Float32Array, b: Float32Array, width: number, height: number): number {
  let total = 0;
  let windows = 0;
  for (let y = 0; y + WINDOW <= height; y += STRIDE) {
    for (let x = 0; x + WINDOW <= width; x += STRIDE) {
      let sumA = 0;
      let sumB = 0;
      for (let j = 0; j < WINDOW; j += 1) {
        for (let i = 0; i < WINDOW; i += 1) {
          const k = (y + j) * width + x + i;
          sumA += a[k] as number;
          sumB += b[k] as number;
        }
      }
      const n = WINDOW * WINDOW;
      const meanA = sumA / n;
      const meanB = sumB / n;
      let varA = 0;
      let varB = 0;
      let covariance = 0;
      for (let j = 0; j < WINDOW; j += 1) {
        for (let i = 0; i < WINDOW; i += 1) {
          const k = (y + j) * width + x + i;
          const da = (a[k] as number) - meanA;
          const db = (b[k] as number) - meanB;
          varA += da * da;
          varB += db * db;
          covariance += da * db;
        }
      }
      varA /= n - 1;
      varB /= n - 1;
      covariance /= n - 1;
      total += ((2 * meanA * meanB + C1) * (2 * covariance + C2))
        / ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
      windows += 1;
    }
  }
  return windows === 0 ? 1 : total / windows;
}

export function compareFrames(a: Uint8Array, b: Uint8Array, width: number, height: number): FrameDifference {
  if (a.length !== b.length) {
    throw new RangeError(`frames differ in size: ${a.length} vs ${b.length} bytes`);
  }
  let maxChannelDelta = 0;
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    let pixelChanged = false;
    for (let c = 0; c < 3; c += 1) {
      const delta = Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0));
      sum += delta;
      if (delta > maxChannelDelta) maxChannelDelta = delta;
      if (delta > 1) pixelChanged = true;
    }
    if (pixelChanged) changed += 1;
  }
  const pixels = width * height;
  return {
    ssim: ssim(luma(a, width, height), luma(b, width, height), width, height),
    maxChannelDelta,
    meanAbsoluteError: sum / (pixels * 3),
    changedPixels: changed / pixels,
  };
}

/**
 * Whether a mismatch is within the cross-machine budget. Deliberately loose on SSIM and tight
 * on the maximum delta: a different driver shifts many pixels by a code value or two, while a
 * real regression moves some pixels a long way.
 */
export function withinCrossMachineBudget(difference: FrameDifference): boolean {
  return difference.ssim >= 0.995 && difference.maxChannelDelta <= 8;
}
