"""Auto-Tuner backend routes.

The real-time retune happens client-side (web AudioWorklet) or in the native
engine (slopsmith-desktop IPC). This module exists for an optional server-side
fallback (e.g. offline rubberband for browsers without AudioWorklet); v1 has no
routes yet. Backend output must go through ``context["log"]`` (Constitution VI).
"""


def setup(app, context):
    log = context["log"]
    log.info("autotune plugin loaded (scaffold; no server routes yet)")
