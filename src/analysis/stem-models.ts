// Which stems each Demucs model produces (M5, S6). Pure, so the studio, the stem job and the tests
// share one answer: a project on `htdemucs_6s` is not "ready" until guitar and piano are too.

import type { Stem } from '../engine/core/params.ts';

/** htdemucs and htdemucs_ft (PROJECT.md M5). */
export const DEMUCS_STEMS: readonly Stem[] = ['drums', 'bass', 'vocals', 'other'];

/** htdemucs_6s (S6): guitar and piano come out of what the four-stem models call "other". */
export const DEMUCS_6S_STEMS: readonly Stem[] = [...DEMUCS_STEMS, 'guitar', 'piano'];

export function stemsForModel(model: string): readonly Stem[] {
  return model === 'htdemucs_6s' ? DEMUCS_6S_STEMS : DEMUCS_STEMS;
}
