"""Song Cents: how far each song's recording sits off its chart tuning, in cents.

Resolution order for a song:
  1. cache (song_cents.json in the config dir), keyed by filename and invalidated by size/mtime
  2. the chart itself: a non-zero arrangement `centOffset` in a sloppak, or `CentOffset` in a
     PSARC's manifest
  3. for a sloppak converted from a PSARC (manifest source.kind == psarc), the source PSARC's
     manifest CentOffset (the conversion dropped it to 0)
  4. otherwise the browser measures it from the song's stem and POSTs it back (source "audio")

Offsets are reported as the residual after whole semitones (the chart tuning already carries
those): -50 < cents <= 50.
"""

import json
import re
import threading
import zipfile
from pathlib import Path

SKIP_ARRS = ("Vocals", "ShowLights", "JVocals")


def _residual(cents):
    try:
        c = float(cents or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return round(c - 100 * round(c / 100), 1)


def _loads_lenient(data):
    try:
        return json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError):
        text = data.decode("utf-8", errors="ignore") if isinstance(data, bytes) else data
        try:
            return json.loads(re.sub(r",\s*([}\]])", r"\1", text))
        except Exception:
            return None


def _psarc_cent_offset(psarc_path):
    """First non-zero CentOffset of a playable arrangement in a PSARC manifest (else 0)."""
    from psarc import read_psarc_entries
    files = read_psarc_entries(str(psarc_path), ["*.json"])
    found = None
    for path, data in sorted(files.items()):
        if not path.endswith(".json"):
            continue
        j = _loads_lenient(data)
        if not isinstance(j, dict):
            continue
        for v in (j.get("Entries") or {}).values():
            attrs = (v or {}).get("Attributes") or {}
            if attrs.get("ArrangementName", "") in SKIP_ARRS or "Tuning" not in attrs:
                continue
            c = attrs.get("CentOffset", 0.0) or 0.0
            if c:
                return float(c)
            found = 0.0 if found is None else found
    return found or 0.0


class _Sloppak:
    """Read files from a sloppak (zip or directory)."""

    def __init__(self, path):
        self.path = Path(path)
        self.zip = zipfile.ZipFile(self.path) if self.path.is_file() else None

    def names(self):
        if self.zip:
            return set(self.zip.namelist())
        return {p.relative_to(self.path).as_posix() for p in self.path.rglob("*") if p.is_file()}

    def read(self, rel):
        if self.zip:
            return self.zip.read(rel)
        return (self.path / rel).read_bytes()

    def close(self):
        if self.zip:
            self.zip.close()


def _sloppak_info(path):
    """(chart_cent_offset, source_psarc_name, stem_rel_path) for a sloppak."""
    import yaml
    sp = _Sloppak(path)
    try:
        names = sp.names()
        manifest = yaml.safe_load(sp.read("manifest.yaml")) if "manifest.yaml" in names else {}
        manifest = manifest or {}
        chart_cents = 0.0
        for entry in manifest.get("arrangements") or []:
            if not isinstance(entry, dict) or entry.get("name") in SKIP_ARRS:
                continue
            for key in ("centOffset", "cent_offset"):
                if entry.get(key):
                    chart_cents = float(entry[key])
            rel = entry.get("file")
            if not chart_cents and rel and rel in names:
                j = _loads_lenient(sp.read(rel))
                if isinstance(j, dict) and j.get("centOffset"):
                    chart_cents = float(j["centOffset"])
            if chart_cents:
                break
        source = manifest.get("source") or {}
        src_psarc = source.get("file") if isinstance(source, dict) and source.get("kind") == "psarc" else None
        stems = {s.get("id"): s.get("file") for s in (manifest.get("stems") or []) if isinstance(s, dict)}
        stem = None
        for sid in ("guitar", "full"):
            if stems.get(sid) in names:
                stem = stems[sid]
                break
        if stem is None:
            stem = next((n for n in sorted(names) if n.endswith(".ogg")), None)
        return chart_cents, src_psarc, stem
    finally:
        sp.close()


def setup(app, context):
    from fastapi import Body

    lock = threading.Lock()
    cache_path = Path(context["config_dir"]) / "song_cents.json"
    log = context.get("log")

    def load():
        try:
            return json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    cache = load()

    def save():
        tmp = cache_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache, indent=1, sort_keys=True), encoding="utf-8")
        tmp.replace(cache_path)

    def stamp(p):
        st = p.stat()
        return f"{st.st_size}:{int(st.st_mtime)}"

    def song_path(filename):
        dlc = context["get_dlc_dir"]()
        if not dlc:
            return None
        p = (Path(dlc) / filename).resolve()
        try:
            p.relative_to(Path(dlc).resolve())
        except ValueError:
            return None
        return p if p.exists() else None

    def resolve(filename):
        p = song_path(filename)
        if p is None:
            return {"file": filename, "error": "not found"}
        st = stamp(p)
        with lock:
            hit = cache.get(filename)
        if hit and hit.get("stamp") == st:
            return dict(hit, file=filename)
        dlc = Path(context["get_dlc_dir"]())
        rec = None
        lower = p.name.lower()
        try:
            if lower.endswith(".psarc"):
                rec = {"cents": _residual(_psarc_cent_offset(p)), "source": "psarc"}
            elif lower.endswith(".sloppak"):
                chart_cents, src_psarc, stem = _sloppak_info(p)
                if _residual(chart_cents):
                    rec = {"cents": _residual(chart_cents), "source": "chart"}
                elif src_psarc and (dlc / src_psarc).exists():
                    c = _residual(_psarc_cent_offset(dlc / src_psarc))
                    if c:
                        rec = {"cents": c, "source": "psarc"}
                if rec is None:
                    # Unknown: the browser measures it. Not cached until it reports back.
                    return {"file": filename, "cents": None, "source": "unmeasured", "stem": stem}
            else:
                rec = {"cents": 0.0, "source": "none"}
        except Exception as e:  # unreadable archive etc.
            if log:
                log.warning("song_cents: %s: %s", filename, e)
            return {"file": filename, "cents": None, "source": "error"}
        rec["stamp"] = st
        with lock:
            cache[filename] = rec
            save()
        return dict(rec, file=filename)

    @app.get("/api/plugins/song_cents/offset")
    def get_offset(file: str):
        return resolve(file)

    @app.post("/api/plugins/song_cents/measured")
    def post_measured(payload: dict = Body(...)):
        filename = str(payload.get("file") or "")
        p = song_path(filename) if filename else None
        if p is None:
            return {"error": "not found"}
        cents = payload.get("cents")
        rec = {
            "cents": None if cents is None else round(float(cents), 1),
            "confidence": round(float(payload.get("confidence") or 0.0), 2),
            "raw": None if payload.get("raw") is None else round(float(payload["raw"]), 1),
            "source": "audio",
            "stamp": stamp(p),
        }
        with lock:
            cache[filename] = rec
            save()
        return dict(rec, file=filename)

    @app.get("/api/plugins/song_cents/pending")
    def get_pending():
        """Library songs with no cached offset (or changed since): the scan resolves these."""
        dlc = context["get_dlc_dir"]()
        if not dlc:
            return {"files": []}
        root = Path(dlc)
        out = []
        for ext in ("*.sloppak", "*.psarc"):
            for p in root.rglob(ext):
                rel = p.relative_to(root).as_posix()
                with lock:
                    hit = cache.get(rel)
                try:
                    if hit and hit.get("stamp") == stamp(p):
                        continue
                except OSError:
                    continue
                out.append(rel)
        return {"files": sorted(out)}

    @app.get("/api/plugins/song_cents/known")
    def get_known():
        with lock:
            return {k: {"cents": v.get("cents"), "source": v.get("source")} for k, v in cache.items()}
