// The spike's synthetic track now lives in src/analysis/reference-track.ts, because the studio
// renders preset thumbnails with it too. Re-exported so the spike and the tests keep their import.

export { synthesizeTestTrack } from '../src/analysis/reference-track.ts';
