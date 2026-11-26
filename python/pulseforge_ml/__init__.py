"""Pulseforge ML sidecar (PROJECT.md §3, M27).

Spawned by Node as `vendor/python/python.exe -m pulseforge_ml <command> ...` with the
repo's `python/` directory as the working directory. Speaks JSON lines on stdout:

    {"event": "progress", "fraction": 0.42, ...}
    {"event": "log", "message": "..."}
    {"event": "result", ...}          exactly once on success
    {"event": "error", "type": "...", "message": "..."}   exactly once on failure

Nothing else is written to stdout; diagnostics go to stderr.

`python -m pulseforge_ml serve` speaks a second, id-addressed protocol on stdin and stdout
instead — see serve.py and src/ml/protocol.ts. One-shot mode is unchanged and is what P0's
validation script drives; serve mode exists because a one-shot process pays ~4 s of start and
model load per command (M27).
"""

PROTOCOL_VERSION = 1
