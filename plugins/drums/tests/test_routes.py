"""routes.py serves only the whitelisted browser modules for the 3D view."""

import importlib.util
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

PLUGIN_DIR = Path(__file__).resolve().parent.parent


def _client():
    spec = importlib.util.spec_from_file_location("drums_routes_under_test", PLUGIN_DIR / "routes.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    app = FastAPI()
    mod.setup(app, {})
    return TestClient(app)


def test_serves_whitelisted_modules():
    c = _client()
    for name in ("engine.js", "highway3d.js"):
        r = c.get(f"/api/plugins/drums/static/{name}")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("application/javascript")
        assert r.text == (PLUGIN_DIR / name).read_text(encoding="utf-8")


def test_rejects_everything_else():
    c = _client()
    for name in ("screen.js", "routes.py", "plugin.json", "..%2Froutes.py", "NOTICE.md", "missing.js"):
        assert c.get(f"/api/plugins/drums/static/{name}").status_code == 404
    assert c.get("/api/plugins/drums/static/../routes.py").status_code == 404
