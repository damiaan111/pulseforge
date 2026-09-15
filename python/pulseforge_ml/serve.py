"""Long-lived server mode for the sidecar (M27, src/ml/protocol.ts).

Why this exists: a one-shot process pays ~4 s of Python start plus model load on every
command (STATUS §5). For a health check that is all of the cost, and for a batch of tracks
it is most of it. Serving keeps the interpreter — and the loaded model — resident.

The protocol is JSON lines both ways, one message per line, every request carrying an `id`
its replies echo. Node's half is `src/ml/protocol.ts`; the two must agree on
SERVE_PROTOCOL_VERSION.

    in   {"type":"request","id":"r1","command":"separate","params":{...}}
         {"type":"cancel","id":"r1"}
         {"type":"shutdown"}
    out  {"type":"ready","protocol":2,"pid":1234}
         {"type":"progress","id":"r1","fraction":0.4,"stage":"separating"}
         {"type":"log","message":"..."}          anything torch printed, forwarded
         {"type":"result","id":"r1","data":{...}}
         {"type":"error","id":"r1","errorType":"...","message":"..."}
         {"type":"cancelled","id":"r1"}

**Cancellation is cooperative.** stdin is read on its own thread so a `cancel` arriving
mid-separation is seen immediately, but the work itself stops at its next checkpoint —
Demucs' per-segment callback. Killing the process instead would throw away a loaded model
and leave half-written stem files behind.
"""

import json
import sys
import threading
import traceback

SERVE_PROTOCOL_VERSION = 2

_write_lock = threading.Lock()


def send(message):
    """One JSON line on stdout. Locked: the reader thread and the worker both report."""
    with _write_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


class Cancelled(Exception):
    """Raised inside a command when the client asked it to stop."""


class Session:
    """The state one served request needs: its id, and whether it has been cancelled."""

    def __init__(self):
        self._cancelled = set()
        self._lock = threading.Lock()
        self.current = None

    def cancel(self, request_id):
        with self._lock:
            self._cancelled.add(request_id)

    def is_cancelled(self, request_id):
        with self._lock:
            return request_id in self._cancelled

    def forget(self, request_id):
        with self._lock:
            self._cancelled.discard(request_id)

    def check(self, request_id):
        if self.is_cancelled(request_id):
            raise Cancelled()


def _read_stdin(queue, session, stop_event):
    """Reads requests on its own thread, so a cancel lands while the worker is busy."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            send({"type": "log", "message": "ignored a line that was not JSON"})
            continue

        kind = message.get("type")
        if kind == "shutdown":
            stop_event.set()
            queue.append(None)
            return
        if kind == "cancel":
            request_id = message.get("id")
            if isinstance(request_id, str):
                session.cancel(request_id)
            continue
        if kind == "request":
            queue.append(message)
    # stdin closed: the parent is gone, so there is nothing left to serve.
    stop_event.set()
    queue.append(None)


def serve(handlers):
    """Run the request loop until shutdown or stdin closes.

    `handlers` maps a command name to `fn(params, context) -> dict`. The context exposes
    `progress(fraction=None, stage=None)` and `check()`, which raises `Cancelled`.
    """
    session = Session()
    queue = []
    stop_event = threading.Event()
    ready = threading.Condition()

    def pump():
        _read_stdin(_NotifyingList(queue, ready), session, stop_event)

    thread = threading.Thread(target=pump, daemon=True, name="pulseforge-stdin")
    thread.start()

    send({"type": "ready", "protocol": SERVE_PROTOCOL_VERSION, "pid": __import__("os").getpid()})

    while True:
        with ready:
            while not queue:
                ready.wait(0.25)
            message = queue.pop(0)
        if message is None:
            return 0

        request_id = message.get("id")
        command = message.get("command")
        params = message.get("params") or {}
        if not isinstance(request_id, str):
            send({"type": "log", "message": "ignored a request with no id"})
            continue

        handler = handlers.get(command)
        if handler is None:
            send({
                "type": "error",
                "id": request_id,
                "errorType": "UnknownCommand",
                "message": f'"{command}" is not a command this sidecar knows',
            })
            continue

        context = _Context(request_id, session)
        session.current = request_id
        try:
            data = handler(params, context)
            send({"type": "result", "id": request_id, "data": data or {}})
        except Cancelled:
            send({"type": "cancelled", "id": request_id})
        except Exception as error:  # a failed request must not end the server
            send({
                "type": "error",
                "id": request_id,
                "errorType": type(error).__name__,
                "message": str(error),
            })
            traceback.print_exc(file=sys.stderr)
        finally:
            session.forget(request_id)
            session.current = None


class _Context:
    """What a handler is given: progress reporting and a cancellation check."""

    def __init__(self, request_id, session):
        self.request_id = request_id
        self._session = session

    def progress(self, fraction=None, stage=None):
        message = {"type": "progress", "id": self.request_id}
        if fraction is not None:
            message["fraction"] = float(fraction)
        if stage is not None:
            message["stage"] = stage
        send(message)

    def log(self, text):
        send({"type": "log", "id": self.request_id, "message": text})

    def check(self):
        """Raises `Cancelled` if the client asked to stop. Call it at every checkpoint."""
        self._session.check(self.request_id)

    @property
    def cancelled(self):
        return self._session.is_cancelled(self.request_id)


class _NotifyingList:
    """A list that wakes the main loop when the reader thread appends to it."""

    def __init__(self, backing, condition):
        self._backing = backing
        self._condition = condition

    def append(self, item):
        with self._condition:
            self._backing.append(item)
            self._condition.notify_all()
