"""Pulseforge ML sidecar (PROJECT.md §3, M27).

Spawned by Node as `vendor/python/python.exe -m pulseforge_ml <command> ...` with the
repo's `python/` directory as the working directory. Speaks JSON lines on stdout:

    {"event": "progress", "fraction": 0.42, ...}
    {"event": "log", "message": "..."}
    {"event": "result", ...}          exactly once on success
    {"event": "error", "type": "...", "message": "..."}   exactly once on failure

Nothing else is written to stdout; diagnostics go to stderr.
"""

PROTOCOL_VERSION = 1
