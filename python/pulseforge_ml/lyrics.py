"""Lyrics transcription and forced alignment (P6, M26; lyrics-spec §4).

The two halves of what WhisperX does, as two served commands, so the matching between them —
which lyric line is which part of the song — happens in TypeScript where it is tested
(src/lyrics/align-match.ts):

    transcribe   faster-whisper (Whisper medium, CTranslate2) on the audio, with its bundled Silero
                 VAD so silence and instrumental breaks produce no hallucinated text. Returns
                 segments with rough word times. Progress by how far through the audio it is.
    align        WhisperX's forced alignment (wav2vec2, CTC) of known text inside time windows.
                 Returns each word's start, end and score. Progress per line; a cancel lands between
                 lines.

Why not `whisperx.load_model`: WhisperX's own VAD front-end imports pyannote.audio 3.x, which
references `torchaudio.AudioMetaData`, gone from the torchaudio that matches the pinned torch. The
pieces used here — faster-whisper with its Silero VAD, and `whisperx.alignment` — are exactly the
components WhisperX wraps, and all of them import and run on this stack (STATUS §4.55).

Everything loads from vendor/ by path. HF_HUB_OFFLINE is set by the host: nothing here may
download (CLAUDE.md #3). Models stay loaded between requests; the supervisor's idle shutdown and
the GPU queue's stop-before-render give the VRAM back.
"""

import importlib.util
import os


def enable_cublas12():
    """CTranslate2 is built for CUDA 12; torch here ships CUDA 13. The CUDA 12 cuBLAS comes from
    the `nvidia-cublas-cu12` wheel, and its folder must be searchable before CTranslate2 loads."""
    spec = importlib.util.find_spec("nvidia.cublas")
    if spec is None or not spec.submodule_search_locations:
        return False
    folder = os.path.join(list(spec.submodule_search_locations)[0], "bin")
    if not os.path.isdir(folder):
        return False
    os.add_dll_directory(folder)
    os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")
    return True


def available():
    """Whether the lyrics tier is installed — without importing it."""
    return all(importlib.util.find_spec(name) is not None for name in ("faster_whisper", "ctranslate2", "whisperx"))


def warm():
    """Imports the native extensions on the main thread, before the stdin reader exists (see
    serve.py's `warmup` note: importing a native extension while a thread blocks on stdin
    deadlocks on Windows). A no-op when the lyrics tier is not installed."""
    if not available():
        return
    enable_cublas12()
    import ctranslate2  # noqa: F401
    import faster_whisper  # noqa: F401
    import whisperx.alignment  # noqa: F401


_whisper = {}
_aligners = {}

SAMPLE_RATE = 16000


def _load_audio(path):
    from faster_whisper.audio import decode_audio

    return decode_audio(path, sampling_rate=SAMPLE_RATE)


def _whisper_model(model_dir, device):
    key = (model_dir, device)
    if key not in _whisper:
        from faster_whisper import WhisperModel

        _whisper.clear()  # one Whisper at a time: they are large
        _whisper[key] = WhisperModel(model_dir, device=device, compute_type="float16" if device == "cuda" else "int8")
    return _whisper[key]


def _aligner(language, model_dir, device):
    key = (language, model_dir, device)
    if key not in _aligners:
        import whisperx

        _aligners.clear()
        _aligners[key] = whisperx.load_align_model(language_code=language, device=device, model_dir=model_dir)
    return _aligners[key]


def transcribe(params, context):
    """{audio, modelDir, language|null, device} → {language, languageProbability, duration, segments}."""
    device = params.get("device", "cuda")
    context.progress(0.0, "loading")
    audio = _load_audio(params["audio"])
    duration = len(audio) / SAMPLE_RATE
    model = _whisper_model(params["modelDir"], device)
    context.check()
    context.progress(0.02, "transcribing")
    segments, info = model.transcribe(
        audio,
        language=params.get("language") or None,
        vad_filter=True,
        word_timestamps=True,
        beam_size=5,
        # Lyrics repeat; conditioning on the previous text makes Whisper loop on a chorus.
        condition_on_previous_text=False,
    )
    out = []
    for segment in segments:
        context.check()
        out.append({
            "start": float(segment.start),
            "end": float(segment.end),
            "text": segment.text.strip(),
            "words": [
                # `text`, as src/lyrics/align-match.ts reads it.
                {"text": w.word.strip(), "start": float(w.start), "end": float(w.end), "probability": float(w.probability)}
                for w in (segment.words or [])
            ],
        })
        if duration > 0:
            context.progress(min(0.99, 0.02 + 0.97 * float(segment.end) / duration), "transcribing")
    return {
        "language": info.language,
        "languageProbability": float(info.language_probability),
        "duration": duration,
        "segments": out,
    }


def align(params, context):
    """{audio, language, modelDir, device, segments:[{id, text, start, end}]} →
    {lines:[{id, start, end, words:[{word, start|null, end|null, score|null}]}]}.

    Aligned one line at a time: progress per line, a cancel between lines, and a line that fails
    to align is reported on its own rather than losing the whole song."""
    import whisperx

    device = params.get("device", "cuda")
    context.progress(0.0, "loading")
    audio = _load_audio(params["audio"])
    model, meta = _aligner(params["language"], params["modelDir"], device)
    segments = params["segments"]
    lines = []
    for index, segment in enumerate(segments):
        context.check()
        try:
            result = whisperx.align(
                [{"text": segment["text"], "start": float(segment["start"]), "end": float(segment["end"])}],
                model, meta, audio, device, return_char_alignments=False,
            )
            words = []
            for aligned in result.get("segments", []):
                for w in aligned.get("words", []):
                    words.append({
                        "word": w.get("word", ""),
                        "start": _number(w.get("start")),
                        "end": _number(w.get("end")),
                        "score": _number(w.get("score")),
                    })
            lines.append({"id": segment["id"], "words": words, "error": None})
        except Exception as error:  # one bad line must not lose the others
            lines.append({"id": segment["id"], "words": [], "error": f"{type(error).__name__}: {error}"})
        context.progress((index + 1) / max(1, len(segments)), "aligning")
    return {"lines": lines}


def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return None if number != number else number  # NaN → None
