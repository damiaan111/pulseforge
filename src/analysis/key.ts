// Musical key: which note a track is centred on, and whether it reads major or minor.
//
// Chroma, then Krumhansl-Schmuckler: the energy in each pitch class over the track is correlated
// with the 24 rotations of Krumhansl and Kessler's tone profiles, and the best fit is the key. It
// is a good guess, not a transcription, and a modulating song has no single answer, so the result
// carries a confidence and a track with no tonal centre (drums, noise, silence) gets no key at all.
// The director uses it for colour; nothing in the engine reads it.
//
// Pure, over a bounded number of frames at fixed positions, so a long track costs no more than a
// few minutes of audio and the same PCM always gives the same key.

import { createFft, hannWindow } from './fft.ts';

export interface MusicalKey {
  /** Pitch class of the tonic: 0 = C, 1 = C#, … 11 = B. */
  readonly tonic: number;
  readonly mode: 'major' | 'minor';
  /** 0..1: how far this key stands above the next best. */
  readonly confidence: number;
}

export const KEY_FORMAT_VERSION = 1;

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** Krumhansl & Kessler (1982): how well each scale degree fits a key, tonic first. */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] as const;
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] as const;

const FFT_SIZE = 16_384;
/** Frames read across the track, evenly: about three seconds of audio is enough per minute of song. */
const MAX_FRAMES = 480;
/** C2 to C7: below it the bins are too wide for semitones, above it is mostly harmonics and air. */
const LOW_HZ = 65.41;
const HIGH_HZ = 2093;
/** Below this correlation the chroma has no tonal shape worth naming. */
const MIN_CORRELATION = 0.5;
/** The gap between best and second best that counts as certain. */
const CERTAIN_GAP = 0.25;

/** "A minor". */
export function keyName(key: MusicalKey): string {
  return `${NOTE_NAMES[key.tonic] ?? '?'} ${key.mode}`;
}

/**
 * 0..1 round the circle of fifths, so neighbouring keys sit next to each other. A minor key takes
 * its relative major's place: A minor and C major share their notes, and so their colour.
 */
export function keyWheelPosition(key: MusicalKey): number {
  const major = key.mode === 'minor' ? (key.tonic + 3) % 12 : key.tonic;
  return ((major * 7) % 12) / 12;
}

/** Twelve pitch-class weights over the track, each frame counted alike; all zero in silence. */
export function chromagram(pcm: Float32Array, sampleRate: number): Float64Array {
  const chroma = new Float64Array(12);
  if (pcm.length < FFT_SIZE) return chroma;
  const fft = createFft(FFT_SIZE);
  const window = hannWindow(FFT_SIZE);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);

  const firstBin = Math.max(1, Math.ceil((LOW_HZ * FFT_SIZE) / sampleRate));
  const lastBin = Math.min(FFT_SIZE / 2 - 1, Math.floor((HIGH_HZ * FFT_SIZE) / sampleRate));
  const pitchClass = new Uint8Array(lastBin + 1);
  for (let bin = firstBin; bin <= lastBin; bin += 1) {
    const midi = 69 + 12 * Math.log2(((bin * sampleRate) / FFT_SIZE) / 440);
    pitchClass[bin] = ((Math.round(midi) % 12) + 12) % 12;
  }

  const frames = Math.min(MAX_FRAMES, Math.floor(pcm.length / FFT_SIZE) * 2);
  const hop = (pcm.length - FFT_SIZE) / Math.max(1, frames - 1);
  const frameChroma = new Float64Array(12);
  for (let frame = 0; frame < frames; frame += 1) {
    const start = Math.floor(frame * hop);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      re[i] = (pcm[start + i] as number) * (window[i] as number);
      im[i] = 0;
    }
    fft.transform(re, im);
    frameChroma.fill(0);
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      const a = re[bin] as number;
      const b = im[bin] as number;
      const pc = pitchClass[bin] as number;
      frameChroma[pc] = (frameChroma[pc] as number) + Math.sqrt(a * a + b * b);
    }
    // Normalised per frame: the tonal content of a quiet verse counts as much as the loud chorus.
    let norm = 0;
    for (const v of frameChroma) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm < 1e-3) continue;
    for (let pc = 0; pc < 12; pc += 1) chroma[pc] = (chroma[pc] as number) + (frameChroma[pc] as number) / norm;
  }
  return chroma;
}

function correlation(chroma: Float64Array, profile: readonly number[], tonic: number): number {
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < 12; i += 1) {
    meanA += (chroma[i] as number) / 12;
    meanB += (profile[i] as number) / 12;
  }
  let product = 0;
  let squareA = 0;
  let squareB = 0;
  for (let i = 0; i < 12; i += 1) {
    const a = (chroma[(i + tonic) % 12] as number) - meanA;
    const b = (profile[i] as number) - meanB;
    product += a * b;
    squareA += a * a;
    squareB += b * b;
  }
  return squareA > 0 && squareB > 0 ? product / Math.sqrt(squareA * squareB) : 0;
}

/** The track's key, or null when it has no tonal centre to speak of. */
export function detectKey(pcm: Float32Array, sampleRate = 48_000): MusicalKey | null {
  const chroma = chromagram(pcm, sampleRate);
  let total = 0;
  for (const v of chroma) total += v;
  if (total <= 0) return null;

  let best: Omit<MusicalKey, 'confidence'> | null = null;
  let bestScore = -Infinity;
  let second = -Infinity;
  for (const mode of ['major', 'minor'] as const) {
    const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
    for (let tonic = 0; tonic < 12; tonic += 1) {
      const score = correlation(chroma, profile, tonic);
      if (score > bestScore) {
        second = bestScore;
        bestScore = score;
        best = { tonic, mode };
      } else if (score > second) second = score;
    }
  }
  if (best === null || bestScore < MIN_CORRELATION) return null;
  return { ...best, confidence: Math.min(1, Math.max(0, (bestScore - second) / CERTAIN_GAP)) };
}

/** For `key.json`; a null key is an answer worth keeping, so the file is written either way. */
export function keyToJson(key: MusicalKey | null): string {
  return JSON.stringify({ formatVersion: KEY_FORMAT_VERSION, key });
}
