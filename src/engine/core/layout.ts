// Layout, anchors and per-layer transforms (PROJECT.md §8.11, module-spec §6).
//
// The rule this file exists to enforce: **nothing is stored in device pixels.** A layer's
// position is a fraction of the canvas and its size follows a declared reference dimension,
// so the same project composes correctly at 1080p and 4K, and in 16:9, 9:16 and 1:1.
//
// Two separate mechanisms, often confused:
//
//  - **The transform** (here) places the layer's rendered image on the canvas: anchor, position,
//    scale, rotation, skew. It is a plain affine, applied by the compositor.
//  - **`scaleReference`** (also here, via `referenceLength`) is handed to the *module* as
//    `ctx.canvas.referenceScale`. It is what makes a logo or a line width keep its physical size
//    when the canvas shape changes — a bar 0.02 of the *smaller* dimension stays the same
//    thickness in vertical, where 0.02 of the width would make it a hairline.
//
// Coordinate spaces, stated once because getting this wrong is invisible until it is not:
//  - **Document space** is what the project stores: y grows downward from the top-left, and a
//    positive `rotationDeg` turns clockwise on screen. This is what a user means.
//  - **Composite space** is what GL uses inside the compositor: y grows upward. The conversion
//    happens exactly once, at the end of `layerMatrix`.

/** Column-major 3×3, as a GL `mat3` uniform expects: [a, b, 0, c, d, 0, tx, ty, 1]. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const ANCHORS = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
] as const;
export type Anchor = (typeof ANCHORS)[number];

export const SCALE_REFERENCES = ['width', 'height', 'min', 'max', 'diagonal'] as const;
export type ScaleReference = (typeof SCALE_REFERENCES)[number];

/** A layer transform with the aspect override already folded in (see src/project/snapshot.ts). */
export interface LayerTransform {
  /** Where the anchor point lands, as a fraction of canvas width/height from the top-left. */
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  /** Clockwise on screen. */
  readonly rotationDeg: number;
  readonly skewXDeg: number;
  readonly skewYDeg: number;
  readonly anchor: Anchor;
  readonly scaleReference: ScaleReference;
}

export const IDENTITY_LAYER_TRANSFORM: LayerTransform = {
  x: 0.5,
  y: 0.5,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  skewXDeg: 0,
  skewYDeg: 0,
  anchor: 'center',
  scaleReference: 'min',
};

/**
 * True when compositing can take the exact 1:1 blit path instead of resampling.
 *
 * The position is only the identity when it *matches the anchor*: a layer anchored top-left
 * and positioned at (0.5, 0.5) puts its top-left corner in the middle of the canvas, which is
 * very much a move. Comparing the position against 0.5 alone would silently blit such a layer
 * unshifted — the transform would work everywhere except at that one combination.
 */
export function isIdentityTransform(t: LayerTransform): boolean {
  const { fx, fy } = anchorFraction(t.anchor);
  return t.x === fx && t.y === fy && t.scaleX === 1 && t.scaleY === 1
    && t.rotationDeg === 0 && t.skewXDeg === 0 && t.skewYDeg === 0;
}

/** Anchor as a fraction of the layer's bounds in document space (y down). */
export function anchorFraction(anchor: Anchor): { readonly fx: number; readonly fy: number } {
  const [vertical, horizontal] = anchor.split('-') as [string, string];
  const fy = vertical === 'top' ? 0 : vertical === 'bottom' ? 1 : 0.5;
  const fx = horizontal === 'left' ? 0 : horizontal === 'right' ? 1 : 0.5;
  return { fx, fy };
}

/**
 * The canvas dimension a layer's sizes are measured against, in pixels (PROJECT.md §8.11).
 * `min` keeps an element the same physical size across aspects; `max` is what a full-bleed
 * background wants; `diagonal` suits radial and glow extents.
 */
export function referenceLength(width: number, height: number, reference: ScaleReference): number {
  switch (reference) {
    case 'width':
      return width;
    case 'height':
      return height;
    case 'min':
      return Math.min(width, height);
    case 'max':
      return Math.max(width, height);
    case 'diagonal':
      return Math.hypot(width, height);
  }
}

// ---------------------------------------------------------------------------
// Affine arithmetic
// ---------------------------------------------------------------------------

function affine(a: number, b: number, c: number, d: number, tx: number, ty: number): Mat3 {
  return [a, b, 0, c, d, 0, tx, ty, 1];
}

export function multiplyMat3(m: Mat3, n: Mat3): Mat3 {
  // Both are affine (bottom row 0,0,1), so only the six meaningful entries are computed.
  const [a1, b1, , c1, d1, , tx1, ty1] = m;
  const [a2, b2, , c2, d2, , tx2, ty2] = n;
  return affine(
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * tx2 + c1 * ty2 + tx1,
    b1 * tx2 + d1 * ty2 + ty1,
  );
}

/** null when the matrix is singular — a zero scale, which makes the layer invisible. */
export function invertMat3(m: Mat3): Mat3 | null {
  const [a, b, , c, d, , tx, ty] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0) return null;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return affine(ia, ib, ic, id, -(ia * tx + ic * ty), -(ib * tx + id * ty));
}

export function applyMat3(m: Mat3, x: number, y: number): { readonly x: number; readonly y: number } {
  return { x: m[0] * x + m[3] * y + m[6], y: m[1] * x + m[4] * y + m[7] };
}

const DEG = Math.PI / 180;

/** Flips y about a canvas of height `h`. Its own inverse, which is why it can be used on both sides. */
function flipY(height: number): Mat3 {
  return affine(1, 0, 0, -1, 0, height);
}

export interface LayerMatrices {
  /** Layer pixels → canvas pixels, in composite (y-up) space. */
  readonly forward: Mat3;
  /** Canvas pixels → layer pixels; what the compositor samples with. null when degenerate. */
  readonly inverse: Mat3 | null;
}

/**
 * The layer's placement matrix. Built in document space as
 * `translate(position) · rotate · skew · scale · translate(-anchor)`, then conjugated into the
 * compositor's y-up space. Identity in, identity out: a layer at the defaults resamples to
 * exactly the pixels the module drew.
 */
export function layerMatrix(t: LayerTransform, width: number, height: number): LayerMatrices {
  const { fx, fy } = anchorFraction(t.anchor);
  const anchorX = fx * width;
  const anchorY = fy * height;
  const positionX = t.x * width;
  const positionY = t.y * height;

  const theta = t.rotationDeg * DEG;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // Clockwise on screen, in a y-down space, is the positive mathematical direction.
  const rotate = affine(cos, sin, -sin, cos, 0, 0);
  const skew = affine(1, Math.tan(t.skewYDeg * DEG), Math.tan(t.skewXDeg * DEG), 1, 0, 0);
  const scale = affine(t.scaleX, 0, 0, t.scaleY, 0, 0);
  const toAnchor = affine(1, 0, 0, 1, -anchorX, -anchorY);
  const toPosition = affine(1, 0, 0, 1, positionX, positionY);

  const documentSpace = multiplyMat3(
    toPosition,
    multiplyMat3(rotate, multiplyMat3(skew, multiplyMat3(scale, toAnchor))),
  );

  const flip = flipY(height);
  const forward = multiplyMat3(flip, multiplyMat3(documentSpace, flip));
  return { forward, inverse: invertMat3(forward) };
}
