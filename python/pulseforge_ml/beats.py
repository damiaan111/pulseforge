"""Beat tracking and structure with librosa (S16, D28).

The app's own tracker (src/analysis/features.ts) finds one tempo and lays a straight grid across the
track: fast, and exact for anything played to a click. Music that breathes (rubato, live drums,
sparse percussion) drifts off a straight grid within a few bars. This is the optional second pass:
a tempo that may change over time, and a dynamic-programming search for the beats along it, which
returns a list of times, the form `BeatGrid` was given for this reason (modulation-spec §6.1).

CPU only: it needs no GPU, the sidecar's models or the GPU queue, so it is a one-shot command rather
than a served one. Its result is stored in the project, so a render never runs this.
"""

import numpy as np

TRACKING_RATE = 22050
HOP = 256
# Seconds of autocorrelation behind each local tempo estimate: long enough to see several beats,
# short enough to follow a change of tempo within a phrase.
TEMPO_WINDOW = 6.0
# Onset detection peaks after an attack begins. Measured against known beat times on six synthetic
# tracks: a steady 19 to 21 ms late, whatever the tempo. A visual on the beat should not be behind it.
ATTACK_LAG = 0.020
# The same range as the built-in tracker, so the two agree on what "the tempo" means.
MIN_BPM = 70.0
MAX_BPM = 180.0
# Mel bands below about 200 Hz: where a kick lives. A beat is more often a kick than a hi-hat, and an
# onset measure that treats all bands alike locks to the hats, half a beat off.
LOW_BANDS = 12


# A track whose beats sit this close to a straight line (seconds, RMS) was played to a click.
STRAIGHT_RMS = 0.035


def _straightened(times):
    """Exact, evenly spaced beats when the music is steady. The search follows each hit, so on
    music made to a click it adds a little jitter of its own; a line through hundreds of beats is
    far more precise than any one of them. Music that really moves does not fit, and is left."""
    index = np.arange(len(times), dtype=float)
    period, start = np.polyfit(index, times, 1)
    line = start + period * index
    if float(np.sqrt(np.mean((times - line) ** 2))) > STRAIGHT_RMS:
        return times
    return np.maximum(line, 0.0)


def _strength(frames, onset):
    """How much the onsets favour the beats over the points between them, 0 to 1. A beat tracker
    always finds something; this is whether it found a pulse."""
    middle = ((frames[:-1] + frames[1:]) / 2).astype(int)
    on = float(np.mean(onset[frames]))
    return float(np.clip(1.0 - float(np.mean(onset[middle])) / max(on, 1e-9), 0.0, 1.0))


def _fold(bpm):
    """The same tempo, by octaves, inside the tracker's range. Works on arrays."""
    bpm = np.asarray(bpm, dtype=float)
    while np.any(bpm > MAX_BPM):
        bpm = np.where(bpm > MAX_BPM, bpm / 2.0, bpm)
    while np.any(bpm < MIN_BPM):
        bpm = np.where(bpm < MIN_BPM, bpm * 2.0, bpm)
    return bpm


def _onsets(y, sr):
    """(all bands, low bands), each scaled to mean 1. The search runs on their sum."""
    import librosa

    mel = librosa.power_to_db(librosa.feature.melspectrogram(y=y, sr=sr, hop_length=HOP, n_mels=64, fmin=30.0), ref=np.max)
    every = librosa.onset.onset_strength(S=mel, sr=sr, hop_length=HOP, aggregate=np.mean)
    low = librosa.onset.onset_strength(S=mel[:LOW_BANDS], sr=sr, hop_length=HOP, aggregate=np.mean)
    return every / (float(np.mean(every)) or 1.0), low / (float(np.mean(low)) or 1.0)


def _on_the_beat(frames, low):
    """The found beats, or the points halfway between them when those are the stronger pulse in the
    low bands: a tracker that follows the tempo perfectly can still be on the off-beats."""
    if len(frames) < 4:
        return frames
    middle = ((frames[:-1] + frames[1:]) / 2).astype(int)
    window = 3  # about 35 ms either side, for a kick that is not exactly on the frame
    peak = lambda at: float(np.mean([np.max(low[max(0, f - window):f + window + 1]) for f in at]))
    return middle if peak(middle) > peak(frames) * 1.2 else frames


def _local_tempo(onset, sr):
    """Beats per minute per onset frame, held to the track's own tempo octave."""
    import librosa
    import scipy.ndimage

    # A wide prior: the default leans on 120 bpm, enough to pull a sparse track off its own pulse.
    overall = float(_fold(librosa.feature.tempo(onset_envelope=onset, sr=sr, hop_length=HOP, aggregate=np.median, std_bpm=8.0)[0]))
    local = librosa.feature.tempo(
        onset_envelope=onset, sr=sr, hop_length=HOP, aggregate=None,
        start_bpm=overall, std_bpm=0.6, ac_size=TEMPO_WINDOW,
    )
    # One window's mistake (half or double) must not bend the grid for a bar.
    frames_per_beat = 60.0 * sr / HOP / max(overall, 1.0)
    size = max(3, int(frames_per_beat * 8) | 1)
    # A window that doubled or halved is folded back towards the overall tempo before the filter.
    near = np.where(local > overall * 1.5, local / 2.0, np.where(local < overall / 1.5, local * 2.0, local))
    return overall, scipy.ndimage.median_filter(near, size=size, mode="nearest")


def _sections(y, sr, beats_frames, duration):
    """Boundaries of the track's parts, in seconds: where timbre and harmony change, by agglomerative
    clustering over beat-synchronous features. More parts for a longer track."""
    import librosa

    if len(beats_frames) < 16:
        return []
    harmony = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP * 4)
    timbre = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=HOP * 4)
    synced = librosa.util.sync(np.vstack([harmony, timbre]), beats_frames // 4, aggregate=np.median)
    parts = int(np.clip(round(duration / 30.0), 3, 12))
    if synced.shape[1] <= parts:
        return []
    starts = librosa.segment.agglomerative(synced, parts)
    frames = librosa.util.fix_frames(beats_frames, x_min=0)
    times = librosa.frames_to_time(frames[np.clip(starts, 0, len(frames) - 1)], sr=sr, hop_length=HOP)
    return [round(float(t), 3) for t in times if 0.0 < t < duration]


def track(pcm, sample_rate, on_stage=lambda stage, fraction: None):
    """Mono float32 samples → {bpm, beats, confidence, sections}. Times in seconds of the audio."""
    import librosa

    on_stage("resampling", 0.05)
    y = librosa.resample(pcm.astype(np.float32), orig_sr=sample_rate, target_sr=TRACKING_RATE, res_type="soxr_hq")
    sr = TRACKING_RATE
    duration = len(y) / sr
    if duration < 4.0 or float(np.max(np.abs(y), initial=0.0)) < 1e-4:
        return {"bpm": 0.0, "beats": [], "confidence": 0.0, "sections": []}

    on_stage("onsets", 0.2)
    every, low = _onsets(y, sr)
    onset = every + low

    on_stage("tempo", 0.4)
    overall, local = _local_tempo(onset, sr)

    on_stage("beats", 0.6)
    _, beats = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=HOP, bpm=local, tightness=200, trim=True, units="frames")
    if len(beats) < 2:
        return {"bpm": 0.0, "beats": [], "confidence": 0.0, "sections": []}
    beats = _on_the_beat(beats, low)
    times = _straightened(np.maximum(librosa.frames_to_time(beats, sr=sr, hop_length=HOP) - ATTACK_LAG, 0.0))
    confidence = _strength(beats, onset)

    on_stage("structure", 0.8)
    sections = _sections(y, sr, beats, duration)
    on_stage("done", 1.0)
    return {
        "bpm": round(60.0 / float(np.median(np.diff(times))), 3),
        "beats": [round(float(t), 4) for t in times],
        "confidence": round(confidence, 3),
        "sections": sections,
    }
