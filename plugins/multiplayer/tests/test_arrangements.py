"""Per-player arrangement names round-trip through the server untouched.

The client resolves a player's arrangement NAME (e.g. "Drums") to a highway
index itself; the server must neither validate nor normalize it, must keep
the queue item's arrangement list as sent, and must only change the
sender's own arrangement.
"""


def _create_room(client, name="Alice"):
    r = client.post("/api/plugins/multiplayer/rooms", json={"name": name})
    r.raise_for_status()
    body = r.json()
    return body["code"], body["player_id"]


def _join_room(client, code, name="Bob"):
    r = client.post(f"/api/plugins/multiplayer/rooms/{code}/join", json={"name": name})
    r.raise_for_status()
    return r.json()["player_id"]


def _ws_url(code, player_id, session_id):
    return f"/ws/plugins/multiplayer/{code}?player_id={player_id}&session_id={session_id}"


def _recv_type(ws, msg_type, limit=20):
    for _ in range(limit):
        msg = ws.receive_json()
        if msg.get("type") == msg_type:
            return msg
    raise AssertionError(f"no {msg_type!r} message")


def test_set_arrangement_drums_is_broadcast_verbatim(client, routes_module):
    code, alice = _create_room(client)
    bob = _join_room(client, code)

    with client.websocket_connect(_ws_url(code, alice, "sid-alice")) as ws_a, \
            client.websocket_connect(_ws_url(code, bob, "sid-bob")) as ws_b:
        _recv_type(ws_a, "connected")
        _recv_type(ws_b, "connected")

        ws_b.send_json({"type": "set_arrangement", "arrangement": "Drums"})

        for ws in (ws_a, ws_b):
            msg = _recv_type(ws, "arrangement_changed")
            assert msg == {"type": "arrangement_changed", "player_id": bob, "arrangement": "Drums"}

    players = routes_module._rooms[code]["players"]
    assert players[bob]["arrangement"] == "Drums"
    assert players[alice]["arrangement"] == "Lead"  # other players unaffected


def test_queue_item_keeps_drums_arrangement(client, routes_module):
    code, alice = _create_room(client)
    arrs = ["Lead", "Bass", "Drums"]
    r = client.post(f"/api/plugins/multiplayer/rooms/{code}/queue", json={
        "player_id": alice, "filename": "song.sloppak",
        "title": "T", "artist": "A", "arrangements": arrs,
    })
    assert r.json() == {"ok": True}

    room = client.get(f"/api/plugins/multiplayer/rooms/{code}").json()
    assert room["queue"][0]["arrangements"] == arrs
