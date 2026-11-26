// The text module's pure parts: animation timing and the string parameter type.

import { describe, expect, it } from 'vitest';

import { resolveParams, type ParamSpec } from '../../src/engine/core/params.ts';
import { textAnimation, textManifest } from '../../src/engine/modules/text.ts';

const layer = { inSeconds: 2, outSeconds: 10 };

describe('textAnimation', () => {
  it('is fully shown between the in and out animations', () => {
    expect(textAnimation(5, layer, 'fade', 'fade', 1, 3)).toEqual({ opacity: 1, offsetEm: 0, scale: 1, blurLod: 0, words: null });
  });

  it('fades in from the in point and out to the out point', () => {
    expect(textAnimation(2, layer, 'fade', 'fade', 1, 3).opacity).toBe(0);
    expect(textAnimation(2.5, layer, 'fade', 'fade', 1, 3).opacity).toBeCloseTo(1 - 0.5 ** 3, 12);
    expect(textAnimation(10, layer, 'fade', 'fade', 1, 3).opacity).toBe(0);
    expect(textAnimation(9.5, layer, 'fade', 'fade', 1, 3).opacity).toBeCloseTo(1 - 0.5 ** 3, 12);
  });

  it('has no exit when the layer runs to the end', () => {
    expect(textAnimation(1000, { inSeconds: 0, outSeconds: null }, 'fade', 'fade', 1, 1).opacity).toBe(1);
  });

  it('slides up in from below and up out above', () => {
    expect(textAnimation(2, layer, 'slide-up', 'none', 1, 1).offsetEm).toBeCloseTo(0.6, 12);
    expect(textAnimation(10, layer, 'none', 'slide-up', 1, 1).offsetEm).toBeCloseTo(-0.6, 12);
  });

  it('combines two animations and blurs in', () => {
    const state = textAnimation(2, layer, 'blur', 'scale', 1, 1);
    expect(state.blurLod).toBe(5);
    expect(state.opacity).toBe(0);
    expect(textAnimation(9.999, { inSeconds: 0, outSeconds: 10 }, 'none', 'scale', 1, 1).scale).toBeCloseTo(0.75, 2);
  });

  it('types words in order and un-types them from the end', () => {
    const typing = textAnimation(2.5, layer, 'typewriter', 'none', 1, 4); // half way: two of four words
    expect([...typing.words!]).toEqual([1, 1, 0, 0]);
    const leaving = textAnimation(9.625, layer, 'none', 'typewriter', 1, 4); // 0.375 left: 1.5 words
    expect([...leaving.words!]).toEqual([1, 0.5, 0, 0]);
    expect(typing.opacity).toBe(1);
  });

  it('staggers smoothly, earlier words ahead of later ones', () => {
    const { words } = textAnimation(2.4, layer, 'stagger', 'none', 1, 5);
    const values = [...words!];
    for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeLessThanOrEqual(values[i - 1]!);
    expect(values[0]).toBeGreaterThan(0);
    expect(values[4]).toBe(0);
  });

  it('with zero duration, is simply on', () => {
    expect(textAnimation(2, layer, 'typewriter', 'fade', 0, 2)).toMatchObject({ opacity: 1, words: new Float32Array([1, 1]) });
  });
});

describe('string parameters', () => {
  const spec: ParamSpec = { key: 'text', label: 'Text', group: 'Text', type: 'string', default: 'hi', maxLength: 5 };

  it('keeps strings, defaults the wrong type, cuts over-long values and reports it', () => {
    expect(resolveParams([spec], { text: 'a\nb' }).values['text']).toBe('a\nb');
    const wrong = resolveParams([spec], { text: 42 });
    expect(wrong.values['text']).toBe('hi');
    expect(wrong.issues[0]?.problem).toBe('wrong-type');
    const long = resolveParams([spec], { text: 'abcdefgh' });
    expect(long.values['text']).toBe('abcde');
    expect(long.issues[0]?.problem).toBe('invalid-value');
  });

  it('the text module declares its sizes non-modulatable (they re-rasterise)', () => {
    const size = textManifest.params.find((p) => p.key === 'size');
    expect(size?.modulatable).toBe(false);
    expect(textManifest.params.find((p) => p.key === 'glow')?.modulatable).toBe(true);
  });
});
