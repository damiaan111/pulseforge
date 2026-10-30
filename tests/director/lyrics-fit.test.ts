// A lyric line wraps at `maxWidth`, and the layer's scale then enlarges the wrapped line, so the two
// multiplied must stay on the canvas or a long line loses its first and last letters.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BUILTIN_MODULES } from '../../src/engine/engine.ts';

const folder = join(import.meta.dirname, '..', '..', 'templates', 'builtin');
const defaultWidth = BUILTIN_MODULES.find((m) => m.manifest.id === 'core.text.lyrics')?.manifest.params.find((p) => p.key === 'maxWidth')?.default as number;

interface Slot {
  readonly role: string;
  readonly params?: { readonly maxWidth?: number };
  readonly transform?: { readonly scale?: number };
  readonly aspectOverrides?: Readonly<Record<string, { readonly transform?: { readonly scale?: number } }>>;
}

describe('built-in templates', () => {
  it.each(readdirSync(folder).filter((f) => f.endsWith('.json')))('%s keeps a full-width lyric line on the canvas', (file) => {
    const template = JSON.parse(readFileSync(join(folder, file), 'utf8')) as { slots: Slot[] };
    for (const slot of template.slots.filter((s) => s.role === 'LYRICS')) {
      const width = slot.params?.maxWidth ?? defaultWidth;
      const scales = [slot.transform?.scale ?? 1, ...Object.values(slot.aspectOverrides ?? {}).map((o) => o.transform?.scale ?? slot.transform?.scale ?? 1)];
      for (const scale of scales) expect(width * scale).toBeLessThanOrEqual(1);
    }
  });
});
