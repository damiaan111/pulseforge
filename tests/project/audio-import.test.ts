// A video's sound and picture go in as one undo step (C14), and the layer lands under everything.

import { describe, expect, it } from 'vitest';

import { useAudioCommand, useVideoAsBackground } from '../../src/project/audio-import.ts';
import { addLayer } from '../../src/project/commands.ts';
import { createDocument, createModuleLayer } from '../../src/project/create.ts';
import type { AssetRef, ModuleLayer } from '../../src/project/document.ts';
import { History } from '../../src/project/history.ts';

const asset: AssetRef = { id: 'clip', kind: 'video', path: 'C:/live.mp4', hash: 'h1', size: 10, name: 'live.mp4', extra: {} };
const options = { path: 'C:/live (sound).flac', durationSeconds: 2, asset, layerId: 'bg', videoModule: 'core.source.video' };

describe('useVideoAsBackground', () => {
  it('sets the audio, adds the clip and puts its layer at the bottom', () => {
    const base = addLayer(createModuleLayer('core.bars', { id: 'bars' })).apply(createDocument({ id: 'p', timestamp: 't' }));
    const after = useVideoAsBackground(base, options).apply(base);
    expect(after.audio).toMatchObject({ path: options.path, durationTicks: 96_000, clipOutTicks: null });
    expect(after.assets).toEqual([asset]);
    expect(after.layers.map((l) => l.id)).toEqual(['bg', 'bars']);
    expect((after.layers[0] as ModuleLayer).params).toEqual({ video: 'clip' });
  });

  it('is one step: undo takes all of it back', () => {
    const history = new History(createDocument({ id: 'p', timestamp: 't' }));
    history.run(useVideoAsBackground(history.current, options));
    expect(history.current.layers).toHaveLength(1);
    history.undo();
    expect(history.current.layers).toEqual([]);
    expect(history.current.assets).toEqual([]);
    expect(history.current.audio.path).toBe('');
  });

  it('shares a clip the project already has', () => {
    const base = { ...createDocument({ id: 'p', timestamp: 't' }), assets: [{ ...asset, id: 'already' }] };
    const after = useVideoAsBackground(base, options).apply(base);
    expect(after.assets.map((a) => a.id)).toEqual(['already']);
    expect((after.layers[0] as ModuleLayer).params).toEqual({ video: 'already' });
  });
});

describe('useAudioCommand', () => {
  it('records the file and its length', () => {
    const after = useAudioCommand('a.flac', 1.5).apply(createDocument({ id: 'p', timestamp: 't' }));
    expect(after.audio).toMatchObject({ path: 'a.flac', durationTicks: 72_000, clipOutTicks: null });
  });
});
