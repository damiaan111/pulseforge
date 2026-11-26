// A title from a file name. Files come named by whatever made them: `Artist - Song (Official Audio).mp3`,
// `song_final_v2 [320kbps].wav`. The words in brackets that describe the file, not the song, are left
// out; anything else in brackets (a remix, a featured artist) is part of the title and stays.

/** What a bracket holds when it is about the file: matched on the whole bracket, ignoring case. */
const FILE_NOTE = /^(?:official(?:\s+(?:music\s+)?(?:audio|video|lyric(?:s)?\s+video|visuali[sz]er))?|audio|video|lyrics?|lyric\s+video|visuali[sz]er|hq|hd|4k|explicit|clean|free\s+download|radio\s*edit|original\s+mix|extended\s+mix|\d{2,4}\s*kbps|(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?|master(?:ed)?|final|demo|v\d+)$/i;

/** The track's title for a title layer: no extension, underscores as spaces, file notes dropped. */
export function titleFromFileName(file: string): string {
  const base = (file.split(/[\\/]/).pop() ?? '').replace(/\.[^.\s]{1,5}$/, '');
  const spaced = base.replace(/_+/g, ' ');
  const kept = spaced.replace(/[([{]([^)\]}]*)[)\]}]/g, (whole, inner: string) => (FILE_NOTE.test(inner.trim()) ? ' ' : whole));
  const tidy = kept.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').replace(/[\s\-–—]+$/g, '').trim();
  // Nothing left means the name was all notes: the name as it stood is better than no title.
  return tidy === '' ? spaced.trim() : tidy;
}
