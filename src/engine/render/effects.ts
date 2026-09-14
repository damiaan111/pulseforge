// The effect chain (module-spec §8, compositor-spec §1 step 3).
//
// An effect reads one texture and returns a new one; it must never write to its input, because
// reading and writing the same attachment is undefined in GL and shows up as tearing that
// varies by driver. So the chain ping-pongs between pooled targets, releasing each one as soon
// as the next pass has consumed it.
//
// Ownership contract, stated once so the pool cannot leak: `runEffectChain` **consumes**
// `source` and returns a target the caller must release exactly once. With no passes it hands
// `source` straight back, so the caller's release is correct either way.

import type { RenderTarget, TargetPool } from './targets.ts';

export interface EffectPass {
  readonly id: string;
  /**
   * Draws into `output`, which is already bound and cleared, reading `input`. `output` is
   * passed explicitly so a multi-pass effect can bind its own scratch framebuffers and still
   * find its way back.
   */
  readonly draw: (input: RenderTarget, output: RenderTarget) => void;
}

export function runEffectChain(
  gl: WebGL2RenderingContext,
  pool: TargetPool,
  source: RenderTarget,
  passes: readonly EffectPass[],
): RenderTarget {
  let current = source;
  for (const pass of passes) {
    const target = pool.acquire(current.width, current.height, current.format);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    // Effects composite their own result; blending here would mix it with whatever the
    // recycled target held last.
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    pass.draw(current, target);
    pool.release(current);
    current = target;
  }
  return current;
}
