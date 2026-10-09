"""Server routes for the drums plugin.

GET /api/plugins/drums/static/{name}
    Serves the plugin's extra browser modules that screen.js loads on demand for the 3D view
    (plugin.json can only name one script). Only the whitelisted files below are served.
"""

from pathlib import Path

from fastapi.responses import Response

_PLUGIN_DIR = Path(__file__).resolve().parent
_ASSETS = {
    "engine.js": "application/javascript",
    "highway3d.js": "application/javascript",
}


def setup(app, context):
    log = context.get("log") if isinstance(context, dict) else None

    @app.get("/api/plugins/drums/static/{name}")
    def drums_static(name: str):
        media_type = _ASSETS.get(name)
        if media_type is None:
            return Response("", status_code=404)
        path = _PLUGIN_DIR / name
        try:
            body = path.read_text(encoding="utf-8")
        except OSError:
            if log:
                log.warning("drums: missing plugin asset %s", name)
            return Response("", status_code=404)
        # no-cache: the browser revalidates, so an updated plugin is picked up (screen.js also adds ?v=).
        return Response(body, media_type=media_type, headers={"Cache-Control": "no-cache"})
