import { describe, expect, it } from 'vitest';

import { titleFromFileName } from '../../src/director/track-title.ts';

describe('a title from a file name', () => {
  it('drops the extension and what describes the file, keeps what belongs to the song', () => {
    expect(titleFromFileName('Night Drive (RadioEdit).mp3')).toBe('Night Drive');
    expect(titleFromFileName('C:\\Music\\Artist - Song (Official Audio) [320kbps].flac')).toBe('Artist - Song');
    expect(titleFromFileName('Artist - Song (feat. Someone) (Official Music Video).wav')).toBe('Artist - Song (feat. Someone)');
    expect(titleFromFileName('Song (Night Remix).mp3')).toBe('Song (Night Remix)');
    expect(titleFromFileName('my_new_song_(final).wav')).toBe('my new song');
    expect(titleFromFileName('Song (2011 Remaster).m4a')).toBe('Song');
  });

  it('keeps dots inside a name, and a name that is only a note', () => {
    expect(titleFromFileName('Mr. Blue Sky.mp3')).toBe('Mr. Blue Sky');
    expect(titleFromFileName('(Demo).wav')).toBe('(Demo)');
    expect(titleFromFileName('track')).toBe('track');
  });
});
