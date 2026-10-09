"""Highway Tweaks — append frame-drop diagnostics posted by screen.js to a JSONL log,
and serialise sloppak unpacking (see _guard_sloppak_unpack)."""

import json
import logging
import sys
import threading
import time
from pathlib import Path

from fastapi import Request

LOG = Path(__file__).parent / "jank_log.jsonl"
MAX_BYTES = 5 * 1024 * 1024


log = logging.getLogger("slopsmith.plugin.highway_tweaks")


def _guard_sloppak_unpack():
    """Serialise sloppak.resolve_source_dir per song.

    Core only locks the cache lookup: the unpack itself (rmtree the cache dir,
    then extract) runs unlocked, so two requests for the same song at once
    (multiplayer: every player loads the queued song together) unpack into the
    same dir and one can read manifest.yaml while the other has just deleted or
    truncated it -> "manifest.yaml must contain a mapping at the top level" and
    a blank highway. With a per-file lock the second caller waits, then gets the
    cached dir. No-op when core already does this (_UNPACK_SERIALISED).
    """
    locks, guard = {}, threading.Lock()

    def lock_for(filename):
        with guard:
            return locks.setdefault(filename, threading.Lock())

    for name in ("sloppak", "lib.sloppak"):
        mod = sys.modules.get(name)
        if mod is None:
            try:
                mod = __import__(name, fromlist=["resolve_source_dir"])
            except Exception:
                continue
        orig = getattr(mod, "resolve_source_dir", None)
        if orig is None or getattr(mod, "_UNPACK_SERIALISED", False) or getattr(orig, "_hwt_guarded", False):
            continue

        def guarded(filename, *args, _orig=orig, **kwargs):
            with lock_for(str(filename)):
                return _orig(filename, *args, **kwargs)

        guarded._hwt_guarded = True
        mod.resolve_source_dir = guarded
        log.info("highway_tweaks: serialised %s.resolve_source_dir per song", name)


def setup(app, context):
    _guard_sloppak_unpack()

    @app.post("/api/plugins/highway_tweaks/log")
    async def log_event(request: Request):
        try:
            entry = await request.json()
        except Exception:
            return {"ok": False}
        entry["server_ts"] = time.strftime("%Y-%m-%d %H:%M:%S")
        if LOG.exists() and LOG.stat().st_size > MAX_BYTES:
            LOG.replace(LOG.with_suffix(".old.jsonl"))
        with LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        return {"ok": True}
