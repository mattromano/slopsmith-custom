"""LAN relay: home-network peers only, real traffic through it, clean stop."""
import importlib.util
import socket
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "mp_lan_relay", Path(__file__).resolve().parent.parent / "lan_relay.py")
lr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lr)


def test_peer_allowed_only_home_network():
    for ok in ("192.168.4.20", "10.0.0.5", "172.16.3.4", "127.0.0.1", "169.254.1.1",
               "::1", "fe80::1%12", "::ffff:192.168.1.9", "fd00::5"):
        assert lr.peer_allowed(ok), ok
    for bad in ("8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8", "", "garbage"):
        assert not lr.peer_allowed(bad), bad


def test_server_port_from_argv():
    argv = ["python", "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "18003"]
    assert lr.server_port_from_argv(argv) == 18003
    assert lr.server_port_from_argv(["x", "--port=8001"]) == 8001
    assert lr.server_port_from_argv(["x"], default=7) == 7
    assert lr.server_port_from_argv(["x", "--port", "nope"], default=7) == 7


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def upstream():
    seen = []

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.client_address[0])
            body = b"hello from slopsmith"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1], seen
    srv.shutdown()


def test_relay_forwards_and_marks_guests(upstream):
    up_port, seen = upstream
    relay = lr.LanRelay()
    port = _free_port()
    relay.start(port, up_port)
    try:
        assert relay.running and relay.port == port
        lan = lr.lan_addresses()
        host = lan[0] if lan else "127.0.0.1"
        body = urllib.request.urlopen(f"http://{host}:{port}/", timeout=5).read()
        assert body == b"hello from slopsmith"
        # The app server sees relayed guests as 127.0.0.2 (or 127.0.0.1 where
        # the OS can't bind it), never as this computer's own browser address.
        assert seen and seen[-1] in ("127.0.0.2", "127.0.0.1")
        if __import__("sys").platform.startswith("win"):
            assert seen[-1] == "127.0.0.2"
    finally:
        relay.stop()
    assert not relay.running
    with pytest.raises(OSError):
        urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2)


def test_start_on_busy_port_reports_error(upstream):
    up_port, _ = upstream
    with socket.socket() as busy:
        busy.bind(("0.0.0.0", 0))
        busy.listen()
        relay = lr.LanRelay()
        with pytest.raises(OSError):
            relay.start(busy.getsockname()[1], up_port)
        assert not relay.running and relay.error


# ── the plugin's /lan endpoints ────────────────────────────────────────────

def _client_from(app, host, base="http://127.0.0.1"):
    from fastapi.testclient import TestClient
    return TestClient(app, base_url=base, client=(host, 50000))


def test_lan_endpoint_only_this_computer_can_toggle(app, tmp_path):
    port = _free_port()
    local = _client_from(app, "127.0.0.1")
    assert local.get("/api/plugins/multiplayer/lan").json()["enabled"] is False

    # A relayed guest (127.0.0.2) or a request naming the LAN address can't flip it.
    guest = _client_from(app, "127.0.0.2")
    assert guest.post("/api/plugins/multiplayer/lan", json={"enabled": True}).status_code == 403
    lan_host = _client_from(app, "127.0.0.1", base="http://192.168.4.72:18765")
    assert lan_host.post("/api/plugins/multiplayer/lan", json={"enabled": True}).status_code == 403
    assert local.get("/api/plugins/multiplayer/lan").json()["enabled"] is False

    r = local.post("/api/plugins/multiplayer/lan", json={"enabled": True, "port": port})
    assert r.status_code == 200
    st = r.json()
    try:
        assert st["enabled"] and st["running"] and st["port"] == port and not st["error"]
        import json
        assert json.loads((tmp_path / "multiplayer" / "lan.json").read_text())["enabled"] is True
    finally:
        st = local.post("/api/plugins/multiplayer/lan", json={"enabled": False}).json()
    assert st["enabled"] is False and st["running"] is False
