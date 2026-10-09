"""Count-in & Play Queue — server side: album track numbers and album order.

Track numbers. No sloppak manifest or PSARC carries one, but every song built
by song_builder records its source audio in ``x_build.audio`` (e.g.
"...Cosmic Thrill Seekers - 13 Klonopin.mp3"), and those files are still on
disk with ID3 tags. Per song, in order of preference:
  1. a ``track`` key in the manifest (future builds can write one);
  2. the ID3 TRCK frame of ``x_build.audio`` (tiny reader below; the app's
     Python has no mutagen);
  3. the track number in that file name ("- 13 Klonopin", "09 Shoelaces");
  4. songs without ``x_build`` (older conversions, PSARCs): the same album's
     audio folder(s) seen in step 2, matched by title.

Album order. ``meta_db.query_artists`` (the tree view) is wrapped on the shared
instance: albums by year (oldest first), songs by track number, and each song
gets a ``track`` field, each album a ``year`` field.

The index is built in a background thread at startup and cached in
``track_cache.json`` next to this file (keyed by file mtime), so only new or
changed sloppaks are re-read.
"""

import json
import logging
import re
import threading
import time
import zipfile
from pathlib import Path

import yaml

log = logging.getLogger("slopsmith.plugin.play_queue")

CACHE = Path(__file__).parent / "track_cache.json"
CACHE_VERSION = 2
AUDIO_EXT = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav"}

_lock = threading.Lock()
_state = {"ready": False, "error": None, "tracks": {}, "arrs": {}, "built": [], "built_at": None, "scanning": False}
_ctx = {}

try:
    _Loader = yaml.CSafeLoader
except AttributeError:  # pragma: no cover
    _Loader = yaml.SafeLoader


def _norm(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _norm_title(s):
    """Title key for matching: no "(Songsterr)" / "[live]" style suffixes, no punctuation."""
    s = re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", s or "")
    s = re.sub(r"\bsongsterr\b", " ", s, flags=re.I)
    return _norm(s)


# ── ID3 track number ───────────────────────────────────────────────────────

def _synchsafe(b):
    return (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3]


def _decode_text(data):
    if not data:
        return ""
    enc, body = data[0], data[1:]
    try:
        if enc == 0:
            return body.decode("latin-1")
        if enc == 1:
            return body.decode("utf-16")
        if enc == 2:
            return body.decode("utf-16-be")
        return body.decode("utf-8")
    except Exception:
        return ""


def id3_track(path):
    """Track number from an MP3's ID3v2 tag (TRCK / TRK), or None."""
    try:
        with open(path, "rb") as f:
            head = f.read(10)
            if len(head) < 10 or head[:3] != b"ID3":
                return None
            ver, flags = head[3], head[5]
            size = _synchsafe(head[6:10])
            tag = f.read(min(size, 1 << 20))
    except OSError:
        return None
    pos = 0
    if flags & 0x40 and ver >= 3:  # extended header
        ext = _synchsafe(tag[0:4]) if ver == 4 else int.from_bytes(tag[0:4], "big") + 4
        pos = ext
    while pos + (6 if ver == 2 else 10) <= len(tag):
        if ver == 2:
            fid, fsize, hdr = tag[pos:pos + 3], int.from_bytes(tag[pos + 3:pos + 6], "big"), 6
        else:
            fid = tag[pos:pos + 4]
            raw = tag[pos + 4:pos + 8]
            fsize = _synchsafe(raw) if ver == 4 else int.from_bytes(raw, "big")
            hdr = 10
        if not fid.strip(b"\x00") or fsize <= 0:
            break
        if fid in (b"TRCK", b"TRK"):
            m = re.match(r"\s*(\d+)", _decode_text(tag[pos + hdr:pos + hdr + fsize]).strip("\x00"))
            return int(m.group(1)) if m else None
        pos += hdr + fsize
    return None


_NAME_TRACK = re.compile(r"(?:^|[\s_.-])(\d{1,2})[\s_.-]+(?=[^\d\s_.-])")


def name_track(path):
    """(track, title) from an audio file name: "Artist - Album - 13 Klonopin.mp3" -> (13, "Klonopin")."""
    stem = Path(path).stem
    found = list(_NAME_TRACK.finditer(stem))
    if not found:
        return None, None
    m = found[-1]
    return int(m.group(1)), stem[m.end():].strip()


def audio_track(path):
    t = id3_track(path) if str(path).lower().endswith(".mp3") else None
    if t is None:
        t, _ = name_track(path)
    return t


# ── manifests ──────────────────────────────────────────────────────────────

def _read_manifest(path):
    try:
        if path.is_dir():
            text = (path / "manifest.yaml").read_text(encoding="utf-8")
        else:
            with zipfile.ZipFile(path) as z:
                name = next((n for n in z.namelist() if n.endswith("manifest.yaml") and n.count("/") <= 1), None)
                if not name:
                    return None
                text = z.read(name).decode("utf-8")
        data = yaml.load(text, Loader=_Loader)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _manifest_info(path):
    """{track, audio, arrs} from a sloppak manifest (cheap fields only)."""
    m = _read_manifest(path)
    if not m:
        return {}
    xb = m.get("x_build") if isinstance(m.get("x_build"), dict) else {}
    track = m.get("track")
    if isinstance(track, str):
        mt = re.match(r"\s*(\d+)", track)
        track = int(mt.group(1)) if mt else None
    arrs = [str(a.get("name", a.get("id", ""))) for a in (m.get("arrangements") or []) if isinstance(a, dict)]
    return {"track": track if isinstance(track, int) else None, "audio": xb.get("audio"), "arrs": arrs}


# ── index ──────────────────────────────────────────────────────────────────

def _library_rows():
    db = _ctx["meta_db"]
    lock = getattr(db, "_lock", None)
    sql = "SELECT filename, artist, album, title, format FROM songs"
    if lock:
        with lock:
            return db.conn.execute(sql).fetchall()
    return db.conn.execute(sql).fetchall()


def _build_index():
    dlc = Path(_ctx["get_dlc_dir"]())
    try:
        cache = json.loads(CACHE.read_text(encoding="utf-8"))
        if cache.get("version") != CACHE_VERSION:
            cache = {}
    except Exception:
        cache = {}
    old = cache.get("files", {})
    files = {}
    rows = _library_rows()
    folders = {}   # (artist, album) -> set of audio folders
    for filename, artist, album, title, fmt in rows:
        path = dlc / filename
        if not filename.lower().endswith(".sloppak"):
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        ent = old.get(filename)
        if not ent or ent.get("mtime") != mtime:
            info = _manifest_info(path)
            ent = {"mtime": mtime, "track": info.get("track"), "audio": info.get("audio"), "arrs": info.get("arrs", [])}
            if ent["track"] is None and ent["audio"] and Path(ent["audio"]).exists():
                ent["track"] = audio_track(ent["audio"])
            elif ent["track"] is None and ent["audio"]:
                ent["track"], _ = name_track(ent["audio"])
        files[filename] = ent
        if ent.get("audio"):
            folders.setdefault((_norm(artist), _norm(album)), set()).add(str(Path(ent["audio"]).parent))

    # Step 4: title match against the album folders for songs still without a track.
    by_album = {}
    for key, dirs in folders.items():
        titles = {}
        for d in dirs:
            try:
                entries = list(Path(d).iterdir())
            except OSError:
                continue
            for p in entries:
                if p.suffix.lower() not in AUDIO_EXT:
                    continue
                t, name = name_track(p)
                if t is None:
                    t = audio_track(p)
                    name = p.stem
                if t is not None and name:
                    titles.setdefault(_norm_title(name), t)
        by_album[key] = titles
    tracks, arrs, built = {}, {}, []
    for filename, artist, album, title, fmt in rows:
        ent = files.get(filename) or {}
        t = ent.get("track")
        if t is None:
            titles = by_album.get((_norm(artist), _norm(album))) or {}
            nt = _norm_title(title)
            t = titles.get(nt)
            if t is None and nt:
                cands = [v for k, v in titles.items() if k and (k in nt or nt in k)]
                if len(set(cands)) == 1:
                    t = cands[0]
        if t is not None:
            tracks[filename] = int(t)
        if ent.get("arrs"):
            arrs[filename] = ent["arrs"]
        if ent.get("audio"):
            built.append(filename)
    try:
        CACHE.write_text(json.dumps({"version": CACHE_VERSION, "files": files}), encoding="utf-8")
    except OSError as e:
        log.warning("play_queue: could not write %s: %s", CACHE, e)
    return tracks, arrs, built


def _refresh():
    with _lock:
        if _state["scanning"]:
            return
        _state["scanning"] = True
    try:
        t0 = time.time()
        tracks, arrs, built = _build_index()
        with _lock:
            _state.update(ready=True, error=None, tracks=tracks, arrs=arrs, built=built, built_at=time.time())
        log.info("play_queue: %d track numbers in %.1fs", len(tracks), time.time() - t0)
    except Exception as e:  # keep the app usable whatever happens
        log.exception("play_queue: track index failed")
        with _lock:
            _state.update(error=f"{type(e).__name__}: {e}")
    finally:
        with _lock:
            _state["scanning"] = False


def _start_refresh():
    threading.Thread(target=_refresh, name="play_queue-tracks", daemon=True).start()


# ── album order in the tree view ───────────────────────────────────────────

def _year(v):
    m = re.match(r"\s*(\d{4})", str(v or ""))
    return int(m.group(1)) if m else None


def order_artists(artists, tracks):
    """Albums oldest first (unknown year last), songs by track number, then title."""
    for a in artists:
        albums = a.get("albums") or []
        for al in albums:
            songs = al.get("songs") or []
            for s in songs:
                s["track"] = tracks.get(s.get("filename"))
            songs.sort(key=lambda s: (s["track"] is None, s["track"] or 0, (s.get("title") or "").lower()))
            years = [y for y in (_year(s.get("year")) for s in songs) if y]
            al["year"] = min(years) if years else None
        albums.sort(key=lambda al: (al["year"] is None, al["year"] or 0, (al.get("name") or "").lower()))
    return artists


def _wrap_query_artists(db):
    orig = getattr(db, "query_artists", None)
    if orig is None or getattr(orig, "_pq_wrapped", False):
        return

    def query_artists(*args, **kwargs):
        artists, total = orig(*args, **kwargs)
        with _lock:
            tracks = _state["tracks"]
        try:
            order_artists(artists, tracks)
        except Exception:
            log.exception("play_queue: album ordering failed")
        return artists, total

    query_artists._pq_wrapped = True
    db.query_artists = query_artists


def setup(app, context):
    _ctx.update(context)
    _wrap_query_artists(context["meta_db"])
    _start_refresh()

    @app.get("/api/plugins/play_queue/tracks")
    def tracks():
        with _lock:
            return {"ready": _state["ready"], "error": _state["error"], "scanning": _state["scanning"],
                    "tracks": _state["tracks"], "arrs": _state["arrs"], "built": _state["built"]}

    @app.post("/api/plugins/play_queue/rescan")
    def rescan():
        _start_refresh()
        return {"ok": True}
