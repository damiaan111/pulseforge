"""Command-line entry for the sidecar. See __init__.py for the protocol."""

import argparse
import json
import sys
import time

from . import PROTOCOL_VERSION


def emit(event, **data):
    sys.stdout.write(json.dumps({"event": event, **data}) + "\n")
    sys.stdout.flush()


def cmd_health(_args):
    import torch

    info = {
        "protocol": PROTOCOL_VERSION,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "torch": torch.__version__,
        "torchCuda": torch.version.cuda,
        "cudaAvailable": bool(torch.cuda.is_available()),
    }
    if info["cudaAvailable"]:
        props = torch.cuda.get_device_properties(0)
        info["device"] = props.name
        info["vramMiB"] = props.total_memory // (1024 * 1024)
        info["cudnn"] = torch.backends.cudnn.version()
    try:
        from importlib import metadata

        info["demucs"] = metadata.version("demucs")
    except Exception as error:  # reported, not fatal: health is a report
        info["demucsError"] = repr(error)
    emit("result", **info)


def cmd_separate(args):
    """One-shot mode: emit the result as before. The P0 validation path depends on this shape."""
    emit("result", **_separate(args, None))


def _separate(args, context):
    """Stem separation. `context` is None one-shot, or serve.py's context when served."""
    from pathlib import Path

    import numpy as np
    import torch
    from demucs.apply import BagOfModels, apply_model
    from demucs.pretrained import get_model

    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available to torch; run `npm run setup -- --verify`")

    started = time.perf_counter()
    model = get_model(args.model, repo=Path(args.repo))
    model.eval()
    if args.device == "cuda":
        torch.cuda.synchronize()
    load_seconds = time.perf_counter() - started

    if model.samplerate != args.sample_rate:
        raise ValueError(f"{args.model} expects {model.samplerate} Hz input, got {args.sample_rate} Hz")
    raw = np.fromfile(args.input, dtype="<f4")
    if raw.size % args.channels != 0:
        raise ValueError(f"input has {raw.size} samples, not divisible by {args.channels} channels")
    wav = torch.from_numpy(raw.reshape(-1, args.channels).T.copy())
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    length = wav.shape[-1]

    # Normalisation as in demucs.separate.
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std()
    if float(std) == 0.0:
        std = torch.tensor(1.0)
    wav = (wav - mean) / std

    models = len(model.models) if isinstance(model, BagOfModels) else 1
    segment = float(getattr(model, "segment", None) or model.models[0].segment)
    stride = int((1 - args.overlap) * model.samplerate * segment)
    total = len(range(0, length, stride)) * models * args.shifts
    done = 0
    last_emit = 0.0

    def on_segment(state):
        nonlocal done, last_emit
        if state.get("state") != "end":
            return
        # The cancellation checkpoint. apply_model calls this once per segment, so a cancel
        # lands within a second or two rather than at the end of the whole separation.
        if context is not None:
            context.check()
        done += 1
        now = time.perf_counter()
        if now - last_emit >= 0.25 or done == total:
            last_emit = now
            fraction = min(1.0, done / total)
            if context is None:
                emit("progress", fraction=fraction, segmentsDone=done, segmentsTotal=total)
            else:
                context.progress(fraction=fraction, stage="separating")

    if args.device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    separate_started = time.perf_counter()
    with torch.no_grad():
        sources = apply_model(
            model, wav[None], device=args.device, shifts=args.shifts, split=True,
            overlap=args.overlap, progress=False, callback=on_segment,
        )[0]
    if args.device == "cuda":
        torch.cuda.synchronize()
    separate_seconds = time.perf_counter() - separate_started
    sources = sources * std + mean

    stem_rms = {name: float(sources[i].pow(2).mean().sqrt()) for i, name in enumerate(model.sources)}
    if args.out_dir:
        out = Path(args.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        for i, name in enumerate(model.sources):
            sources[i].T.contiguous().numpy().astype("<f4").tofile(out / f"{name}.f32")

    result = {
        "model": args.model,
        "sources": list(model.sources),
        "models": models,
        "sampleRate": model.samplerate,
        "audioSeconds": length / model.samplerate,
        "loadSeconds": load_seconds,
        "separateSeconds": separate_seconds,
        "realtimeFactor": (length / model.samplerate) / separate_seconds,
        "segments": total,
        "stemRms": stem_rms,
    }
    if args.device == "cuda":
        result["peakAllocatedMiB"] = torch.cuda.max_memory_allocated() / 2**20
        result["peakReservedMiB"] = torch.cuda.max_memory_reserved() / 2**20
        result["device"] = torch.cuda.get_device_name(0)
    return result


def _served_health(_params, _context):
    """Health as a served command. Returns the report instead of emitting it."""
    import torch

    info = {
        "protocol": PROTOCOL_VERSION,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "torch": torch.__version__,
        "torchCuda": torch.version.cuda,
        "cudaAvailable": bool(torch.cuda.is_available()),
    }
    if info["cudaAvailable"]:
        props = torch.cuda.get_device_properties(0)
        info["device"] = props.name
        info["vramMiB"] = props.total_memory // (1024 * 1024)
    return info


def _served_separate(params, context):
    """Stem separation, reporting progress and stopping when asked (serve.py)."""
    args = argparse.Namespace(
        input=params["input"],
        channels=int(params.get("channels", 2)),
        sample_rate=int(params.get("sampleRate", 44100)),
        model=params.get("model", "htdemucs"),
        repo=params["repo"],
        out_dir=params.get("outDir"),
        device=params.get("device", "cuda"),
        shifts=int(params.get("shifts", 1)),
        overlap=float(params.get("overlap", 0.25)),
    )
    return _separate(args, context)


def _warm_native_extensions():
    """Import the native extensions on the main thread, before the reader thread exists.

    torch pulls in numpy's `_multiarray`; demucs pulls in torch. Importing any of them while
    a thread is blocked reading stdin deadlocks on Windows (see serve.py's `warmup` note), so
    a served `separate` would hang on its first call. Paying it here also means `ready` is
    honest and no request carries the ~2 s import cost.
    """
    import torch  # noqa: F401
    from demucs.pretrained import get_model  # noqa: F401

    # The lyrics tier, when installed: the same rule applies to CTranslate2 and WhisperX.
    from . import lyrics

    lyrics.warm()


def cmd_serve(_args):
    """Long-lived mode: one process, many requests, model stays loaded (M27)."""
    from .serve import serve

    from . import lyrics

    return serve(
        {"health": _served_health, "separate": _served_separate, "transcribe": lyrics.transcribe, "align": lyrics.align},
        warmup=_warm_native_extensions,
    )


def main(argv=None):
    parser = argparse.ArgumentParser(prog="pulseforge_ml")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("health", help="report interpreter, torch, CUDA and demucs versions")
    commands.add_parser("serve", help="long-lived JSON-lines server on stdin/stdout")

    separate = commands.add_parser("separate", help="stem separation with Demucs")
    separate.add_argument("--input", required=True, help="raw little-endian float32 PCM, interleaved")
    separate.add_argument("--channels", type=int, default=2)
    separate.add_argument("--sample-rate", type=int, default=44100)
    separate.add_argument("--model", default="htdemucs")
    separate.add_argument("--repo", required=True, help="folder holding the model yaml + weights")
    separate.add_argument("--out-dir", help="write each stem as <name>.f32")
    separate.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    separate.add_argument("--shifts", type=int, default=1)
    separate.add_argument("--overlap", type=float, default=0.25)

    args = parser.parse_args(argv)
    try:
        if args.command == "serve":
            return cmd_serve(args) or 0
        {"health": cmd_health, "separate": cmd_separate}[args.command](args)
        return 0
    except Exception as error:
        emit("error", type=type(error).__name__, message=str(error))
        import traceback

        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
