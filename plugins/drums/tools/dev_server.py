"""Dev server for the drums plugin harnesses (no song library needed).

    python plugins/drums/tools/dev_server.py [port]        # from the repository root, default port 8766

Serves the repository root, core's /static (vendored three.js) and this plugin's real routes.py, so
tools/app.html runs screen.js exactly as Slopsmith would load it:
    http://127.0.0.1:8766/plugins/drums/tools/app.html
"""

import importlib.util
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

PLUGIN_DIR = Path(__file__).resolve().parent.parent
REPO = PLUGIN_DIR.parent.parent
CORE_STATIC = REPO / "slopsmith" / "static"


def build_app() -> FastAPI:
    app = FastAPI()
    spec = importlib.util.spec_from_file_location("drums_routes", PLUGIN_DIR / "routes.py")
    routes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(routes)
    routes.setup(app, {})
    app.mount("/static", StaticFiles(directory=str(CORE_STATIC)), name="static")
    app.mount("/", StaticFiles(directory=str(REPO)), name="repo")
    return app


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    uvicorn.run(build_app(), host="127.0.0.1", port=port, log_level="warning")
