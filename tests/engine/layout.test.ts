// Layout, anchors and the layer transform matrix (PROJECT.md §8.11, module-spec §6).
//
// All CPU maths, and the place where a sign error hides for weeks: the matrix is built in
// document space (y down, clockwise rotation) and used in composite space (y up). These tests
// pin the conversion by checking where known points land.

import { describe, expect, it } from 'vitest';

import {
  anchorFraction, applyMat3, invertMat3, isIdentityTransform, IDENTITY_LAYER_TRANSFORM,
  IDENTITY_MAT3, layerMatrix, multiplyMat3, referenceLength, type LayerTransform,
} from '../../src/engine/core/layout.ts';

const W = 1920;
const H = 1080;

const transform = (overrides: Partial<LayerTransform> = {}): LayerTransform => ({
  ...IDENTITY_LAYER_TRANSFORM,
  ...overrides,
});

/** Document-space point (y down) → composite-space point (y up), for stating expectations. */
const gl = (x: number, y: number) => ({ x, y: H - y });

const near = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
};

describe('referenceLength', () => {
  it('picks the dimension a layer declared', () => {
    expect(referenceLength(1920, 1080, 'width')).toBe(1920);
    expect(referenceLength(1920, 1080, 'height')).toBe(1080);
    expect(referenceLength(1920, 1080, 'min')).toBe(1080);
    expect(referenceLength(1920, 1080, 'max')).toBe(1920);
    expect(referenceLength(3, 4, 'diagonal')).toBe(5);
  });

  it('gives the same number in landscape and portrait for min and diagonal', () => {
    // This is the property the whole aspect system rests on: an element sized against `min`
    // is the same number of pixels in 16:9 and 9:16, so it looks the same physical size.
    expect(referenceLength(1920, 1080, 'min')).toBe(referenceLength(1080, 1920, 'min'));
    expect(referenceLength(1920, 1080, 'diagonal')).toBeCloseTo(referenceLength(1080, 1920, 'diagonal'), 9);
    expect(referenceLength(1920, 1080, 'width')).not.toBe(referenceLength(1080, 1920, 'width'));
  });
});

describe('anchorFraction', () => {
  it('maps the nine-point grid in document space', () => {
    expect(anchorFraction('top-left')).toEqual({ fx: 0, fy: 0 });
    expect(anchorFraction('center')).toEqual({ fx: 0.5, fy: 0.5 });
    expect(anchorFraction('bottom-right')).toEqual({ fx: 1, fy: 1 });
    expect(anchorFraction('bottom-center')).toEqual({ fx: 0.5, fy: 1 });
    expect(anchorFraction('center-left')).toEqual({ fx: 0, fy: 0.5 });
  });
});

describe('matrix arithmetic', () => {
  it('multiplies as function composition, outer first', () => {
    const translate = [1, 0, 0, 0, 1, 0, 10, 20, 1] as const;
    const scale = [2, 0, 0, 0, 3, 0, 0, 0, 1] as const;
    // translate(scale(v)) — the scale applies before the shift.
    near(applyMat3(multiplyMat3(translate, scale), 1, 1), { x: 12, y: 23 });
    near(applyMat3(multiplyMat3(scale, translate), 1, 1), { x: 22, y: 63 });
  });

  it('inverts an affine, and refuses a singular one', () => {
    const m = [2, 0, 0, 0, 4, 0, 5, 7, 1] as const;
    const inverse = invertMat3(m);
    expect(inverse).not.toBeNull();
    near(applyMat3(inverse!, ...Object.values(applyMat3(m, 3, 9)) as [number, number]), { x: 3, y: 9 });
    expect(invertMat3([0, 0, 0, 0, 0, 0, 0, 0, 1])).toBeNull();
    expect(invertMat3([1, 0, 0, 2, 0, 0, 0, 0, 1])).toBeNull();
  });
});

describe('layerMatrix', () => {
  it('is the identity at the default transform', () => {
    const { forward } = layerMatrix(transform(), W, H);
    forward.forEach((value, i) => expect(value).toBeCloseTo(IDENTITY_MAT3[i] as number, 9));
  });

  it('places the anchor point at the position, in document coordinates', () => {
    // A layer anchored bottom-centre, positioned at the bottom-centre of the canvas, does not
    // move: the layer's own bottom-centre pixel is already there.
    const { forward } = layerMatrix(transform({ anchor: 'bottom-center', x: 0.5, y: 1 }), W, H);
    near(applyMat3(forward, ...[W / 2, gl(0, H).y] as [number, number]), gl(W / 2, H));
  });

  it('moves the layer when the position moves, in document space', () => {
    // y = 0.25 is a quarter of the way *down* the canvas.
    const { forward } = layerMatrix(transform({ y: 0.25 }), W, H);
    const centreOfLayer = gl(W / 2, H / 2);
    near(applyMat3(forward, centreOfLayer.x, centreOfLayer.y), gl(W / 2, H * 0.25));
  });

  it('scales about the anchor', () => {
    const { forward } = layerMatrix(transform({ scaleX: 0.5, scaleY: 0.5 }), W, H);
    // The centre is the anchor, so it is fixed…
    near(applyMat3(forward, W / 2, H / 2), { x: W / 2, y: H / 2 });
    // …and the top-left corner comes in to a quarter of the way across and down.
    const topLeft = gl(0, 0);
    near(applyMat3(forward, topLeft.x, topLeft.y), gl(W * 0.25, H * 0.25));
  });

  it('rotates clockwise on screen for a positive angle', () => {
    const { forward } = layerMatrix(transform({ rotationDeg: 90 }), W, H);
    // A point directly above the centre in document space (smaller y) must end up to the
    // *right* of the centre after a 90° clockwise turn.
    const above = gl(W / 2, H / 2 - 100);
    const result = applyMat3(forward, above.x, above.y);
    near(result, gl(W / 2 + 100, H / 2));
  });

  it('rounds trips through its own inverse', () => {
    const t = transform({ x: 0.3, y: 0.8, scaleX: 1.7, scaleY: 0.4, rotationDeg: 37, skewXDeg: 12, skewYDeg: -5, anchor: 'top-left' });
    const { forward, inverse } = layerMatrix(t, W, H);
    expect(inverse).not.toBeNull();
    const point = applyMat3(forward, 123, 456);
    near(applyMat3(inverse!, point.x, point.y), { x: 123, y: 456 });
  });

  it('reports a collapsed transform rather than producing a bogus inverse', () => {
    expect(layerMatrix(transform({ scaleX: 0 }), W, H).inverse).toBeNull();
    expect(layerMatrix(transform({ scaleY: 0 }), W, H).inverse).toBeNull();
  });

  it('is aspect-independent: the same fractions land in the same relative place', () => {
    const t = transform({ x: 0.25, y: 0.75, anchor: 'top-left' });
    const landscape = layerMatrix(t, 1920, 1080);
    const portrait = layerMatrix(t, 1080, 1920);
    const a = applyMat3(landscape.forward, 0, 1080); // the layer's top-left, in y-up pixels
    const b = applyMat3(portrait.forward, 0, 1920);
    expect(a.x / 1920).toBeCloseTo(b.x / 1080, 9);
    expect(1 - a.y / 1080).toBeCloseTo(1 - b.y / 1920, 9);
  });
});

describe('isIdentityTransform', () => {
  it('holds when the position matches the anchor, whichever anchor that is', () => {
    expect(isIdentityTransform(transform())).toBe(true);
    expect(isIdentityTransform(transform({ anchor: 'top-left', x: 0, y: 0 }))).toBe(true);
    expect(isIdentityTransform(transform({ anchor: 'bottom-right', x: 1, y: 1 }))).toBe(true);
    // Scale reference feeds the module, not the placement, so it cannot move anything here.
    expect(isIdentityTransform(transform({ scaleReference: 'max' }))).toBe(true);
  });

  it('does not hold when the anchor and position disagree', () => {
    // The trap: anchored top-left but positioned centre puts the corner in the middle.
    expect(isIdentityTransform(transform({ anchor: 'top-left' }))).toBe(false);
    expect(isIdentityTransform(transform({ x: 0.51 }))).toBe(false);
    expect(isIdentityTransform(transform({ scaleY: 1.0001 }))).toBe(false);
  });

  it('agrees with the matrix it is a shortcut for', () => {
    // Anything isIdentityTransform accepts must actually produce the identity matrix, or the
    // blit path and the resample path would disagree.
    for (const anchor of ['top-left', 'center', 'bottom-right', 'center-left'] as const) {
      const { fx, fy } = anchorFraction(anchor);
      const t = transform({ anchor, x: fx, y: fy });
      expect(isIdentityTransform(t)).toBe(true);
      layerMatrix(t, W, H).forward.forEach((value, i) => expect(value).toBeCloseTo(IDENTITY_MAT3[i] as number, 9));
    }
  });
});
