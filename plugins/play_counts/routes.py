"""Play Counts — show how often each song has been played, in the library.

Total plays per song = Rocksmith 2014 plays (read from the encrypted Steam
profile, never written) + Slopsmith plays (practice-journal sessions of at
least MIN_SESSION_SECONDS). A song's PSARC and its converted sloppak share
one count: they are grouped by artist + title.

Also adds a server-side "plays" sort to the library by wrapping
meta_db.query_page (the local library provider calls it through the shared
instance, so wrapping the bound method on that instance is enough).
"""

import json
import re
import sqlite3
import threading
import time
import zlib
from pathlib import Path

from Crypto.Cipher import AES

# Rocksmith 2014 profile key (well known; same one the bundled profileimport plugin uses).
PROFILE_KEY = bytes.fromhex("728B369E24ED01347685110218 12AFC0A3C25D02065F166B4BCC58CD2644F29E".replace(" ", ""))
MIN_SESSION_SECONDS = 30
SLOP_REFRESH_S = 10

_lock = threading.Lock()
_state = {
    "ready": False,
    "error": None,
    "profile": None,           # path of the profile used
    "profile_mtime": None,
    "library_size": None,
    "rs_by_group": {},         # group -> Rocksmith plays
    "slop_by_group": {},       # group -> Slopsmith plays
    "slop_at": 0.0,
    "group_of": {},            # library filename -> group
    "counts": {},              # library filename -> [rocksmith, slopsmith]
    "rs_scores": {},           # group -> {arr kind: Rocksmith mastery/streak}
    "slop_journal": {},        # group -> [plays, seconds, last played]
}
_ctx = {}


def _norm(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _group_key(filename, artist, title):
    if _norm(title):
        return _norm(artist) + "|" + _norm(title)
    stem = Path(filename).stem
    return "f:" + _norm(re.sub(r"_(p|m|pc|mac)$", "", stem, flags=re.I))


# ── Rocksmith profile ───────────────────────────────────────────────────────

def _find_profile():
    dlc = _ctx["get_dlc_dir"]()
    roots = []
    if dlc:
        # ...\Steam\steamapps\common\Rocksmith2014\dlc -> ...\Steam
        roots.append(Path(dlc).resolve().parents[3] / "userdata")
    roots.append(Path(r"C:\Program Files (x86)\Steam\userdata"))
    files = []
    for root in roots:
        if root.is_dir():
            files += [p for p in root.glob("*/221680/remote/*") if p.name.lower().endswith("_prfldb")]
    # The active profile is the one Rocksmith wrote most recently.
    return max(files, key=lambda p: p.stat().st_mtime) if files else None


def _read_profile(path):
    data = path.read_bytes()
    if data[:4] != b"EVAS":
        raise ValueError("not a Rocksmith profile")
    raw = zlib.decompress(AES.new(PROFILE_KEY, AES.MODE_ECB).decrypt(data[20:])).rstrip(b"\0")
    return {pid.upper(): v for pid, v in json.loads(raw).get("Stats", {}).get("Songs", {}).items()}


def _num(v):
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _arr_key(name):
    """'Lead', 'Lead 2', 'Bonus Rhythm' … -> lead / rhythm / bass / combo."""
    n = (name or "").lower()
    for k in ("bass", "rhythm", "lead", "combo"):
        if k in n:
            return k
    return _norm(n) or "?"


# ── PSARC arrangement-ID mapping (cached by mtime/size) ─────────────────────

def _db():
    conn = sqlite3.connect(str(Path(_ctx["config_dir"]) / "play_counts.db"), check_same_thread=False)
    conn.execute("CREATE TABLE IF NOT EXISTS psarc_arrs (filename TEXT PRIMARY KEY, mtime REAL, size INTEGER, arrs TEXT)")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT NOT NULL, arr TEXT NOT NULL,"
        " filename TEXT, title TEXT, artist TEXT, arrangement TEXT, ts TEXT NOT NULL, accuracy REAL NOT NULL,"
        " hits INTEGER, misses INTEGER, best_streak INTEGER, complete INTEGER NOT NULL, speed REAL, progress REAL,"
        " played_s REAL)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_song ON runs(grp, arr)")
    if "details" not in {r[1] for r in conn.execute("PRAGMA table_info(runs)")}:
        conn.execute("ALTER TABLE runs ADD COLUMN details TEXT")
    return conn


def _psarc_arrs(dlc_dir):
    """Return {library filename: {persistent ID: arrangement name}} for every PSARC in the DLC dir."""
    from psarc import read_psarc_entries

    dlc = Path(dlc_dir)
    conn = _db()
    cached = {r[0]: (r[1], r[2], r[3]) for r in conn.execute("SELECT filename, mtime, size, arrs FROM psarc_arrs")}
    out, fresh = {}, []
    for p in dlc.rglob("*.psarc"):
        rel = p.relative_to(dlc).as_posix()
        st = p.stat()
        c = cached.get(rel)
        if c and c[0] == st.st_mtime and c[1] == st.st_size:
            out[rel] = json.loads(c[2])
            continue
        arrs = {}
        try:
            for name, blob in read_psarc_entries(str(p), ["*.json"]).items():
                try:
                    for entry in json.loads(blob).get("Entries", {}).values():
                        attrs = entry.get("Attributes", {})
                        if attrs.get("PersistentID") and attrs.get("ArrangementName") != "Vocals":
                            arrs[attrs["PersistentID"].upper()] = attrs.get("ArrangementName") or ""
                except (ValueError, AttributeError):
                    pass
        except Exception:
            pass  # unreadable PSARC: no plays attributed
        out[rel] = arrs
        fresh.append((rel, st.st_mtime, st.st_size, json.dumps(arrs)))
    if fresh:
        conn.executemany("INSERT OR REPLACE INTO psarc_arrs VALUES (?, ?, ?, ?)", fresh)
        conn.commit()
    conn.close()
    return out


# ── Scores (note-detection runs + Rocksmith mastery) ────────────────────────
# A run counts toward a song's best only when it was complete (song played to
# the end, no A-B loop) at full speed. Every run is kept for the history.

def _is_best_run(complete, speed):
    return bool(complete) and (speed or 0) >= 0.999


def _group_for(filename, artist="", title=""):
    with _lock:
        g = _state["group_of"].get(filename)
    return g or _group_key(filename, artist, title)


def _rs_for(g, arr=None):
    with _lock:
        by_arr = _state["rs_scores"].get(g) or {}
    return by_arr.get(arr) if arr else by_arr


def _best_by_group():
    """{group: [best counted accuracy, has a full combo]}."""
    conn = _db()
    try:
        return {g: [b, bool(fc)] for g, b, fc in conn.execute(
            "SELECT grp, MAX(accuracy), MAX(misses = 0) FROM runs WHERE complete = 1 AND speed >= 0.999"
            " GROUP BY grp")}
    finally:
        conn.close()


def _scores():
    """{library filename: [Slopsmith best % or None, Rocksmith best mastery % or None, full combo]}."""
    best = _best_by_group()
    with _lock:
        group_of, rs = _state["group_of"], _state["rs_scores"]
        out = {}
        for fn, g in group_of.items():
            b, fc = best.get(g) or [None, False]
            r = max((v["mastery_peak"] for v in (rs.get(g) or {}).values()), default=None)
            if b is not None or r:
                out[fn] = [b, r, fc]
        return out


WEEK_S = 7 * 86400


def _ts_epoch(ts):
    try:
        return time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
    except (TypeError, ValueError):
        return 0.0


def _song(filename, arrangement, artist="", title="", exclude_id=None):
    g, arr = _group_for(filename, artist, title), _arr_key(arrangement)
    conn = _db()
    conn.row_factory = sqlite3.Row
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT id, ts, accuracy, hits, misses, best_streak, complete, speed, progress, played_s, details FROM runs"
            " WHERE grp = ? AND arr = ? ORDER BY id", (g, arr))]
    finally:
        conn.close()
    prior = [r for r in rows if r["id"] != exclude_id]
    counted = [r for r in prior if _is_best_run(r["complete"], r["speed"])]
    best = max(counted, key=lambda r: (r["accuracy"], -r["id"]), default=None)
    # Best pass per chart section (any run, partial or not: section practice counts).
    section_best = {}
    for r in prior:
        if not r["details"]:   # the client only records full-speed passes
            continue
        try:
            secs = json.loads(r["details"]).get("sections") or {}
        except ValueError:
            continue
        for k, v in secs.items():
            if isinstance(v, list) and v and v[0] is not None and v[0] > section_best.get(k, -1):
                section_best[k] = v[0]
    cutoff = time.time() - WEEK_S
    old = [r["accuracy"] for r in counted if _ts_epoch(r["ts"]) < cutoff]
    with _lock:
        jr = (_state.get("slop_journal") or {}).get(g) or [0, 0.0, None]
    runs = [{k: r[k] for k in ("ts", "accuracy", "hits", "misses", "best_streak", "complete", "speed", "progress")}
            for r in reversed(prior[-40:])]
    return {
        "group": g, "arr": arr, "runs": runs, "run_count": len(prior),
        "best": {k: best[k] for k in ("ts", "accuracy", "best_streak")} if best else None,
        "best_streak": max((r["best_streak"] or 0 for r in prior), default=0),
        "full_combos": sum(1 for r in counted if not r["misses"]),
        "section_best": section_best,
        "week_ago_best": max(old) if old else None,
        "first_counted": counted[0]["accuracy"] if counted else None,
        "practice_s": round(jr[1] or 0),
        "sessions": jr[0],
        "rocksmith": _rs_for(g, arr),
    }


def _add_run(d):
    filename = str(d.get("filename") or "")
    arrangement = str(d.get("arrangement") or "")
    hits, misses = int(d.get("hits") or 0), int(d.get("misses") or 0)
    if not filename or hits + misses < 1:
        raise ValueError("filename and judgments required")
    acc = round(100.0 * hits / (hits + misses), 1)
    complete, speed = 1 if d.get("complete") else 0, float(d.get("speed") or 1.0)
    details = d.get("details") if isinstance(d.get("details"), dict) else None
    g, arr = _group_for(filename, d.get("artist") or "", d.get("title") or ""), _arr_key(arrangement)
    conn = _db()
    try:
        cur = conn.execute(
            "INSERT INTO runs (grp, arr, filename, title, artist, arrangement, ts, accuracy, hits, misses, best_streak,"
            " complete, speed, progress, played_s, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (g, arr, filename, d.get("title"), d.get("artist"), arrangement,
             time.strftime("%Y-%m-%dT%H:%M:%S"), acc, hits, misses, int(d.get("best_streak") or 0), complete, speed,
             float(d.get("progress") or 0), float(d.get("played_s") or 0), json.dumps(details) if details else None))
        conn.commit()
        run_id = cur.lastrowid
    finally:
        conn.close()
    before = _song(filename, arrangement, d.get("artist") or "", d.get("title") or "", exclude_id=run_id)
    out = _song(filename, arrangement, d.get("artist") or "", d.get("title") or "")
    counted = _is_best_run(complete, speed)
    prev_best = before["best"]["accuracy"] if before["best"] else None
    out.update(
        accuracy=acc, counted=counted, full_combo=counted and misses == 0,
        prev_best=prev_best, prev_section_best=before["section_best"],
        new_best=counted and prev_best is not None and acc > prev_best,
        first_full_run=counted and prev_best is None,
    )
    return out


# ── Library + practice journal ──────────────────────────────────────────────

def _library_rows():
    meta_db = _ctx["meta_db"]
    with meta_db._lock:
        return meta_db.conn.execute("SELECT filename, artist, title FROM songs").fetchall()


def _utc_to_local(iso):
    from datetime import datetime
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%dT%H:%M:%S")
    except (AttributeError, ValueError):
        return None


def _slopsmith_journal(group_of):
    """{group: [plays (sessions >= MIN_SESSION_SECONDS), total seconds, last session (local ISO)]}."""
    path = Path(_ctx["config_dir"]) / "practice_journal.db"
    if not path.exists():
        return {}
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT filename, SUM(duration_seconds >= ?), SUM(duration_seconds), MAX(started_at)"
            " FROM practice_sessions GROUP BY filename", (MIN_SESSION_SECONDS,)).fetchall()
    finally:
        conn.close()
    out = {}
    for fn, n, secs, last in rows:
        g = group_of.get(fn) or _group_key(fn, "", "")
        o = out.setdefault(g, [0, 0.0, None])
        o[0] += int(n or 0)
        o[1] += float(secs or 0)
        last = _utc_to_local(last)
        if last and (o[2] is None or last > o[2]):
            o[2] = last
    return out


def _slopsmith_plays(group_of):
    journal = _slopsmith_journal(group_of)
    return {g: v[0] for g, v in journal.items() if v[0]}, journal


# ── Compact library table ───────────────────────────────────────────────────

TABLE_COLS = ["filename", "artist", "title", "album", "year", "duration", "tuning", "parts", "format",
              "rs_plays", "slop_plays", "best", "rs_mastery", "fc", "last_played", "practice_s"]
_ARR_ORDER = {"lead": 0, "rhythm": 1, "bass": 2, "combo": 3}


def _table():
    meta_db = _ctx["meta_db"]
    with meta_db._lock:
        rows = meta_db.conn.execute(
            "SELECT filename, artist, title, album, year, duration, tuning_name, tuning, arrangements, format"
            " FROM songs").fetchall()
    best = _best_by_group()
    conn = _db()
    try:
        last_run = dict(conn.execute("SELECT grp, MAX(ts) FROM runs GROUP BY grp").fetchall())
    finally:
        conn.close()
    with _lock:
        group_of, rs, rs_plays = _state["group_of"], _state["rs_scores"], _state["rs_by_group"]
        journal = _state.get("slop_journal") or {}
    out = []
    for fn, artist, title, album, year, dur, tname, tuning, arrs, fmt in rows:
        g = group_of.get(fn) or _group_key(fn, artist, title)
        try:
            kinds = {_arr_key(a.get("name")) for a in json.loads(arrs or "[]") if isinstance(a, dict)}
        except ValueError:
            kinds = set()
        parts = "".join(k[0].upper() for k in sorted(kinds & _ARR_ORDER.keys(), key=_ARR_ORDER.get))
        rsd = rs.get(g) or {}
        peak = max((v["mastery_peak"] for v in rsd.values()), default=None) or None
        rs_last = max((v["last_played"] or "" for v in rsd.values()), default="").replace(" ", "T") or None
        j = journal.get(g) or [0, 0.0, None]
        b, fc = best.get(g) or [None, False]
        last = max((x for x in (rs_last, j[2], last_run.get(g)) if x), default=None)
        out.append([fn, artist or "", title or "", album or "", year or "", round(dur or 0), tname or tuning or "",
                    parts, fmt or "", rs_plays.get(g, 0), j[0], b, peak, bool(fc), last, round(j[1] or 0)])
    return out


def _rebuild_counts():
    rs, slop, group_of = _state["rs_by_group"], _state["slop_by_group"], _state["group_of"]
    counts = {}
    for fn, g in group_of.items():
        a, b = rs.get(g, 0), slop.get(g, 0)
        if a or b:
            counts[fn] = [a, b]
    _state["counts"] = counts


def _refresh_rocksmith():
    """Full rebuild: library groups + Rocksmith plays. Runs in a background thread."""
    try:
        rows = _library_rows()
        group_of = {fn: _group_key(fn, artist, title) for fn, artist, title in rows}
        profile = _find_profile()
        rs_by_group, rs_scores = {}, {}
        if profile:
            stats = _read_profile(profile)
            arr_map = _psarc_arrs(_ctx["get_dlc_dir"]())
            pids_by_group = {}
            for fn, arrs in arr_map.items():
                g = group_of.get(fn)
                if g:
                    pids_by_group.setdefault(g, {}).update(arrs)
            # Union of IDs per song: the _p and _m copies of a PSARC share
            # arrangement IDs, so each Rocksmith play is counted once.
            for g, arrs in pids_by_group.items():
                n = sum(int(_num(stats.get(pid, {}).get("PlayedCount"))) for pid in arrs)
                if n:
                    rs_by_group[g] = n
                # Per-arrangement scores. Several arrangements can share a
                # kind (Lead + alt Lead); keep the best of each.
                for pid, name in arrs.items():
                    s = stats.get(pid)
                    if not s or not _num(s.get("PlayedCount")):
                        continue
                    k = _arr_key(name)
                    cur = rs_scores.setdefault(g, {}).get(k)
                    peak = round(_num(s.get("MasteryPeak")) * 100, 1)
                    if cur and cur["mastery_peak"] >= peak:
                        continue
                    rs_scores[g][k] = {
                        "arrangement": name,
                        "mastery_peak": peak,
                        "mastery_last": round(_num(s.get("MasteryLast")) * 100, 1),
                        "streak": int(_num(s.get("Streak"))),
                        "plays": int(_num(s.get("PlayedCount"))),
                        "last_played": s.get("DateLAS") or None,
                    }
        slop, journal = _slopsmith_plays(group_of)
        with _lock:
            _state.update(
                group_of=group_of, rs_by_group=rs_by_group, rs_scores=rs_scores, slop_by_group=slop, slop_journal=journal, slop_at=time.time(),
                profile=str(profile) if profile else None,
                profile_mtime=profile.stat().st_mtime if profile else None,
                library_size=len(rows), ready=True, error=None,
            )
            _rebuild_counts()
    except Exception as e:  # keep the app usable; surface the error via /status
        with _lock:
            _state.update(error=f"{type(e).__name__}: {e}", ready=True)
    finally:
        _state["refreshing"] = False


def _maybe_refresh():
    """Cheap checks on each request: re-read Slopsmith plays every few seconds,
    and kick a background rebuild when the Rocksmith profile or library changed."""
    if not _state.get("refreshing"):
        profile = None
        try:
            profile = _find_profile()
        except Exception:
            pass
        try:
            with _ctx["meta_db"]._lock:
                lib_size = _ctx["meta_db"].conn.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
        except Exception:
            lib_size = _state["library_size"]
        if (profile and profile.stat().st_mtime != _state["profile_mtime"]) or lib_size != _state["library_size"]:
            _start_refresh()
    if _state["ready"] and time.time() - _state["slop_at"] > SLOP_REFRESH_S:
        slop, journal = _slopsmith_plays(_state["group_of"])
        with _lock:
            _state.update(slop_by_group=slop, slop_journal=journal, slop_at=time.time())
            _rebuild_counts()


def _start_refresh():
    if _state.get("refreshing"):
        return
    _state["refreshing"] = True
    threading.Thread(target=_refresh_rocksmith, name="play_counts_refresh", daemon=True).start()


def _plays(filename):
    c = _state["counts"].get(filename)
    return (c[0] + c[1]) if c else 0


def _wrap_query_page(meta_db):
    if getattr(meta_db.query_page, "_play_counts_wrapped", False):
        return
    orig = meta_db.query_page

    def query_page(*args, **kwargs):
        if kwargs.get("sort") != "plays":
            return orig(*args, **kwargs)
        page = int(kwargs.pop("page", 0) or 0)
        size = int(kwargs.pop("size", 24) or 24)
        kwargs["sort"] = "artist"   # stable base order for ties
        kwargs.pop("direction", None)
        try:
            _maybe_refresh()
        except Exception:
            pass
        songs, total = orig(*args, page=0, size=1_000_000, **kwargs)
        songs.sort(key=lambda s: -_plays(s.get("filename", "")))
        return songs[page * size:(page + 1) * size], total

    query_page._play_counts_wrapped = True
    meta_db.query_page = query_page


def setup(app, context):
    from fastapi import Request

    _ctx.update(context)
    _wrap_query_page(context["meta_db"])
    _start_refresh()

    @app.get("/api/plugins/play_counts/counts")
    def counts():
        _maybe_refresh()
        with _lock:
            ready, counts = _state["ready"], _state["counts"]
        return {"ready": ready, "counts": counts, "scores": _scores()}

    @app.post("/api/plugins/play_counts/run")
    async def add_run(request: Request):
        try:
            return {"ok": True, **_add_run(await request.json())}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    @app.get("/api/plugins/play_counts/table")
    def table():
        _maybe_refresh()
        with _lock:
            ready = _state["ready"]
        return {"ready": ready, "cols": TABLE_COLS, "rows": _table()}

    @app.get("/api/plugins/play_counts/song")
    def song(filename: str, arrangement: str = "", artist: str = "", title: str = ""):
        _maybe_refresh()
        return _song(filename, arrangement, artist, title)

    @app.get("/api/plugins/play_counts/status")
    def status():
        with _lock:
            return {
                "ready": _state["ready"], "error": _state["error"], "refreshing": bool(_state.get("refreshing")),
                "profile": _state["profile"], "library_size": _state["library_size"],
                "songs_with_plays": len(_state["rs_by_group"].keys() | _state["slop_by_group"].keys()),
                "rocksmith_plays": sum(_state["rs_by_group"].values()),
                "slopsmith_plays": sum(_state["slop_by_group"].values()),
            }
