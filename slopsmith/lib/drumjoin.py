"""Attach a "Drums" arrangement to an existing sloppak.

Sources, in priority order (``join(..., sources=("chart", "gp"))``):

a) a YARG / Clone Hero chart folder, matched to the song by fuzzy artist/title.  Charts
   are synced to their own audio, so the chart is aligned to ours: cross-correlation of
   the chart's drums stem (else its full mix, else an envelope synthesised from its hits)
   against our stems/drums.ogg gives a global offset (song.ini ``delay`` honoured).  Weak
   correlation or drift -> a beat-level warp (dynamic-programming lag tracking sampled at
   the chart's beats + per-beat onset refinement), i.e. the chart's tempo map warped onto our audio.
b) the Guitar Pro tab's drum track, placed with the build's stored tab->audio beat map
   (x_sync.json, the same map the guitar charts use; gp2rs.convert_drum_track gives the
   same ``string*24+fret`` encoding the editor plugin uses).
c) automatic transcription from stems/drums.ogg: a pluggable hook only
   (``register_transcriber``); none ships yet - see PROGRESS.md for the options.

Every candidate is validated against onsets detected on stems/drums.ogg (median offset,
% of notes within +-30 ms, drift).  A failing candidate is reported and NOT written
unless ``force`` is set.
"""
from __future__ import annotations

import difflib
import json
import re
import shutil
import tempfile
import time
import unicodedata
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

import drumalign
import drumchart

DRUMS_NAME = re.compile(r"\b(?:drums?|percussion|drum\s*kit)\b", re.I)


def is_drums_arrangement(entry_or_name) -> bool:
    name = entry_or_name if isinstance(entry_or_name, str) else \
        f"{entry_or_name.get('name', '')} {entry_or_name.get('id', '')}"
    return bool(DRUMS_NAME.search(name or ""))


# ── fuzzy song matching ─────────────────────────────────────────────────────

def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\((?:[^)]*(?:songsterr|remaster|live|demo|version|edit|mix|feat|ft\.)[^)]*)\)", " ", s)
    s = re.sub(r"\[[^\]]*\]", " ", s)
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"^\s*the\s+", "", s)
    return re.sub(r"\s+", " ", s).strip()


def name_score(a_artist, a_title, b_artist, b_title) -> float:
    t = difflib.SequenceMatcher(None, norm_name(a_title), norm_name(b_title)).ratio()
    ar = difflib.SequenceMatcher(None, norm_name(a_artist), norm_name(b_artist)).ratio()
    return 0.65 * t + 0.35 * ar


@dataclass
class ChartEntry:
    folder: Path
    artist: str
    title: str


def index_chart_dir(root: Path) -> list[ChartEntry]:
    """Every song folder (has song.ini or notes.mid/.chart) below root."""
    out, seen = [], set()
    root = Path(root)
    for p in sorted(root.rglob("*")):
        if p.name.lower() not in ("song.ini", "notes.mid", "notes.chart"):
            continue
        folder = p.parent
        if folder in seen:
            continue
        seen.add(folder)
        ini = drumchart.load_song_ini(folder / "song.ini")
        artist, title = ini.get("artist", ""), ini.get("name", "")
        if not title:   # "Artist - Title" folder names are the CH convention
            parts = folder.name.split(" - ", 1)
            artist, title = (parts if len(parts) == 2 else ("", folder.name))
        out.append(ChartEntry(folder, artist, title))
    return out


def best_match(entries: list[ChartEntry], artist: str, title: str, min_score=0.82):
    scored = sorted(((name_score(artist, title, e.artist, e.title), e) for e in entries),
                    key=lambda x: -x[0])
    if scored and scored[0][0] >= min_score:
        return scored[0][1], scored[0][0]
    return None, (scored[0][0] if scored else 0.0)


# ── sloppak access ──────────────────────────────────────────────────────────

class SloppakFiles:
    """Read/write view over a sloppak in zip or directory form (writes go to a work dir)."""

    def __init__(self, path: Path):
        import yaml
        self.path = Path(path)
        self.is_dir = self.path.is_dir()
        if self.is_dir:
            self.dir = self.path
            self._tmp = None
        else:
            self._tmp = Path(tempfile.mkdtemp(prefix="drumjoin_"))
            with zipfile.ZipFile(self.path) as z:
                z.extractall(self._tmp)
            self.dir = self._tmp
        self.manifest = yaml.safe_load((self.dir / "manifest.yaml").read_text(encoding="utf-8"))

    def stem(self, sid: str) -> Path | None:
        for s in self.manifest.get("stems", []):
            if s.get("id") == sid and (self.dir / s["file"]).exists():
                return self.dir / s["file"]
        return None

    def mix_audio(self) -> np.ndarray | None:
        full = self.stem("full")
        if full is not None:
            return drumalign.load_audio(full)
        ys = [drumalign.load_audio(self.dir / s["file"]) for s in self.manifest.get("stems", [])
              if (self.dir / s["file"]).exists()]
        if not ys:
            return None
        n = max(len(y) for y in ys)
        return sum(np.pad(y, (0, n - len(y))) for y in ys)

    def drums_audio(self) -> tuple[np.ndarray | None, str]:
        d = self.stem("drums")
        if d is not None:
            return drumalign.load_audio(d), "drums"
        y = self.mix_audio()
        return y, "mix"

    def read_json(self, rel: str):
        return json.loads((self.dir / rel).read_text(encoding="utf-8"))

    def save(self, backup_dir: Path | None = None):
        import yaml
        (self.dir / "manifest.yaml").write_text(yaml.safe_dump(self.manifest, sort_keys=False, allow_unicode=True),
                                                encoding="utf-8")
        if self.is_dir:
            return
        if backup_dir:
            backup_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.path, backup_dir / f"{self.path.stem}.{time.strftime('%Y%m%d-%H%M%S')}{self.path.suffix}")
        tmp = self.path.with_name(self.path.name + ".tmp")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
            for f in sorted(self.dir.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(self.dir).as_posix())
        tmp.replace(self.path)

    def close(self):
        if self._tmp:
            shutil.rmtree(self._tmp, ignore_errors=True)
            self._tmp = None


def write_drums(sp: SloppakFiles, arrangement: dict, x_drums: dict, backup_dir=None):
    """Add (or replace) the Drums arrangement and record how it was made."""
    arrangement = dict(arrangement)
    arrangement.pop("beats", None)       # song-level data lives on the first arrangement only
    arrangement.pop("sections", None)
    arrs = [e for e in sp.manifest.get("arrangements", []) if not is_drums_arrangement(e)]
    for e in sp.manifest.get("arrangements", []):
        if is_drums_arrangement(e) and (sp.dir / e["file"]).exists():
            (sp.dir / e["file"]).unlink()
    (sp.dir / "arrangements").mkdir(exist_ok=True)
    (sp.dir / "arrangements" / "drums.json").write_text(json.dumps(arrangement, separators=(",", ":")),
                                                         encoding="utf-8")
    arrs.append({"id": "drums", "name": "Drums", "file": "arrangements/drums.json",
                 "tuning": [0] * 6, "capo": 0})
    sp.manifest["arrangements"] = arrs
    sp.manifest["x_drums"] = x_drums
    sp.save(backup_dir)


# ── candidates ──────────────────────────────────────────────────────────────

@dataclass
class Candidate:
    source: str                         # "chart" | "gp" | "transcribe:<name>"
    chart: drumchart.DrumChart          # already placed on our audio
    detail: dict = field(default_factory=dict)
    validation: drumalign.Validation | None = None


def _chart_audio(folder: Path) -> tuple[np.ndarray | None, str]:
    files = drumchart.song_audio_files(folder)
    files.pop("crowd", None)
    pick = files.get("drums")
    kind = "drums"
    if not pick:
        pick = [p for ps in files.values() for p in ps]
        kind = "mix"
    if not pick:
        return None, "none"
    ys = [drumalign.load_audio(p) for p in pick]
    n = max(len(y) for y in ys)
    return sum(np.pad(y, (0, n - len(y))) for y in ys), kind


def align_chart(folder: Path, sp: SloppakFiles, *, onsets=None, force_method: str | None = None,
                min_conf: float = 3.0, min_ratio: float = 1.08, max_drift: float = 0.035,
                log=print) -> Candidate:
    """Source (a): place a YARG/CH chart on the sloppak's audio."""
    chart, ini = drumchart.load_song_folder(folder)
    ours_drums, ours_kind = sp.drums_audio()
    if ours_drums is None:
        raise RuntimeError("sloppak has no audio")
    src_y, src_kind = _chart_audio(folder)
    # compare like with like: chart drums stem <-> our drums stem, chart mix <-> our mix
    if src_kind == "mix" and ours_kind == "drums":
        ref_y = sp.mix_audio()
    else:
        ref_y = ours_drums
    ref_env = drumalign.onset_env(ref_y)
    drums_env = drumalign.onset_env(ours_drums) if ref_y is not ours_drums else ref_env
    # chart hits are in chart-audio time (delay applied); chart audio starts at 0
    hit_times = np.array([h.time for h in chart.hits])
    if src_y is not None:
        src_env = drumalign.onset_env(src_y)
    else:
        src_kind = "synthetic"
        n = int((hit_times.max() + 5) * drumalign.FR)
        src_env = drumalign.synth_env([(h.time, h.pad, h.cymbal) for h in chart.hits], n)
        ref_env = drums_env
        ref_y = ours_drums
    al = drumalign.global_offset(ref_env, src_env)
    log(f"  xcorr ({src_kind} vs our {'drums' if ref_y is ours_drums else 'mix'}): offset {al.offset:+.3f}s, "
        f"confidence {al.confidence:.1f}, peak ratio {al.peak_ratio:.2f}, drift {al.drift * 1000:.0f} ms "
        f"over {len(al.local)} windows")
    weak = al.confidence < min_conf or al.peak_ratio < min_ratio
    drifting = al.drift > max_drift
    method = force_method or ("warp" if (weak or drifting) else "offset")
    if method == "warp":
        beats = [b["time"] for b in chart.beat_list()]
        pairs = drumalign.warp_pairs(ref_env, src_env, beats, hit_times, al.offset, onset_ref_env=drums_env)
        al = drumalign.Alignment("warp", al.offset, al.confidence, al.peak_ratio, al.local, al.drift, pairs,
                                 rate=drumalign.LAST_RATE.get("rate", 1.0))
        log(f"  beat-level warp over {len(pairs)} chart beats ({'weak correlation' if weak else 'drift'})")
    warp = al.warp()
    snap = drumalign.snap_correction([warp(t) for t in hit_times], onsets) if onsets is not None else 0.0
    if snap:
        log(f"  snapped {snap * 1000:+.1f} ms onto the stem's drum onsets")
    al.snap = snap
    placed = drumchart.shift_chart(chart, lambda t: warp(t) + snap)
    det = {"folder": str(Path(folder).resolve()), "artist": ini.get("artist"), "title": ini.get("name"),
           "chart_audio": src_kind, "delay": chart.offset, "alignment": al.summary(),
           "format": chart.source_format}
    return Candidate("chart", placed, det)


def gp_drum_chart(gp_path: Path, tab_beats, audio_beats, offset: float = 0.0, track: int | None = None):
    """Source (b): GP drum track -> DrumChart on our audio via the stored beat map."""
    import xml.etree.ElementTree as ET
    import guitarpro
    import gp2rs
    song = guitarpro.parse(str(gp_path))
    idxs = [i for i, t in enumerate(song.tracks) if gp2rs.is_drum_track(t)] if track is None else [track]
    if not idxs:
        return None, {}
    tb, ab = np.asarray(tab_beats, float), np.asarray(audio_beats, float)
    warp = drumalign._pw_linear(tb, ab)
    # the busiest drum track
    best, best_hits = None, []
    for idx in idxs:
        root = ET.fromstring(gp2rs.convert_drum_track(song, idx, 0.0, "Drums"))
        raw = []
        for n in root.iter("note"):
            raw.append((float(n.get("time")), int(n.get("string")) * 24 + int(n.get("fret")),
                        n.get("accent") == "1", n.get("mute") == "1"))
        for c in root.iter("chord"):
            t = float(c.get("time"))
            for cn in c.iter("chordNote"):
                raw.append((t, int(cn.get("string")) * 24 + int(cn.get("fret")),
                            cn.get("accent") == "1", cn.get("mute") == "1"))
        if len(raw) > len(best_hits):
            best, best_hits = idx, raw
    hits = []
    for t, gm, acc, ghost in sorted(best_hits):
        pc = drumchart.GM_TO_PAD.get(gm)
        if pc is None:
            continue
        hits.append(drumchart.DrumHit(time=round(warp(t) + offset, 4), pad=pc[0], cymbal=pc[1],
                                      kick2x=False, dyn="accent" if acc else "ghost" if ghost else None))
    seen, uniq = set(), []
    for h in hits:
        k = (round(h.time, 3), h.pad, h.cymbal)
        if k not in seen:
            seen.add(k)
            uniq.append(h)
    chart = drumchart.DrumChart(hits=uniq, tempo=drumchart.TempoMap(480), source_format="gp")
    return chart, {"gp": str(gp_path), "track": best, "track_name": song.tracks[best].name if best is not None else None}


def gp_candidate(sp: SloppakFiles, gp_path: Path | None = None, log=print) -> Candidate | None:
    xb = sp.manifest.get("x_build") or {}
    gp_path = Path(gp_path or xb.get("gp") or "")
    if not gp_path or not gp_path.exists():
        log(f"  no GP tab available ({gp_path or 'x_build.gp missing'})")
        return None
    if not (sp.dir / "x_sync.json").exists():
        log("  sloppak has no x_sync.json beat map; can't place the GP drum track")
        return None
    sync = json.loads((sp.dir / "x_sync.json").read_text(encoding="utf-8"))
    chart, det = gp_drum_chart(gp_path, sync["tab_beats"], sync["audio_beats"], float(xb.get("offset") or 0.0))
    if chart is None or not chart.hits:
        log("  the GP tab has no drum track")
        return None
    det["sync_method"] = (sync.get("report") or {}).get("method")
    return Candidate("gp", chart, det)


# ── (c) transcription hook ──────────────────────────────────────────────────

_TRANSCRIBERS: dict = {}


def register_transcriber(name: str, fn):
    """fn(drums_wav_path: Path, sr: int) -> list[DrumHit] (times in the stem's seconds)."""
    _TRANSCRIBERS[name] = fn


def transcribe_candidate(sp: SloppakFiles, name: str, log=print) -> Candidate | None:
    fn = _TRANSCRIBERS.get(name)
    stem = sp.stem("drums")
    if fn is None or stem is None:
        log(f"  transcriber {name!r} not available" if fn is None else "  no drums stem to transcribe")
        return None
    hits = fn(stem, drumalign.SR)
    return Candidate(f"transcribe:{name}", drumchart.DrumChart(hits=list(hits), tempo=drumchart.TempoMap(480),
                                                               source_format="transcribed"), {"transcriber": name})


# ── driver ──────────────────────────────────────────────────────────────────

def validate_candidate(c: Candidate, onsets, thresholds=None, bands=None) -> drumalign.Validation:
    c.validation = drumalign.validate([h.time for h in c.chart.hits], onsets, thresholds,
                                      pad_hits=[(h.time, h.pad, h.cymbal) for h in c.chart.hits], bands=bands)
    return c.validation


def finalize_chart(chart: drumchart.DrumChart, sp: SloppakFiles) -> drumchart.DrumChart:
    """Generate star power / fills when the source had none (GP tabs, transcriptions)."""
    if not chart.star_power:
        beats = _sloppak_beats(sp)
        chart.star_power = drumchart.auto_star_power([h.time for h in chart.hits], beats)
        chart.fills = drumchart.auto_fills([h.time for h in chart.hits], beats, chart.star_power, chart.solos,
                                           _sloppak_sections(sp))
    elif not chart.fills:
        beats = _sloppak_beats(sp)
        chart.fills = drumchart.auto_fills([h.time for h in chart.hits], beats, chart.star_power, chart.solos,
                                           _sloppak_sections(sp))
    return chart


def _first_arr(sp):
    for e in sp.manifest.get("arrangements", []):
        if not is_drums_arrangement(e) and (sp.dir / e["file"]).exists():
            d = sp.read_json(e["file"])
            if d.get("beats"):
                return d
    return {}


def _sloppak_beats(sp):
    return [(b["time"], b.get("measure", -1)) for b in _first_arr(sp).get("beats", [])]


def _sloppak_sections(sp):
    return [s["time"] for s in _first_arr(sp).get("sections", [])]


def join(sloppak: Path, *, chart_folder: Path | None = None, gp_path: Path | None = None,
         sources=("chart", "gp"), transcriber: str | None = None, force=False, dry_run=False,
         force_method: str | None = None, thresholds=None, backup_dir=None, report_path=None,
         log=print) -> dict:
    sp = SloppakFiles(sloppak)
    report = {"sloppak": str(sloppak), "title": sp.manifest.get("title"), "artist": sp.manifest.get("artist"),
              "candidates": [], "written": None}
    try:
        stem = sp.stem("drums")
        if stem is None:
            log("  no stems/drums.ogg; validating against the full mix (less reliable)")
            onsets = drumalign.detect_onsets(sp.mix_audio())
            bands = None     # the mix's low band is full of bass guitar: no per-pad check
        else:
            stem_y = drumalign.load_audio(stem)
            onsets = drumalign.detect_onsets(stem_y)
            bands = drumalign.band_onsets(stem_y)
        order = list(sources) + ([f"transcribe:{transcriber}"] if transcriber else [])
        chosen = None
        for src in order:
            cand = None
            try:
                if src == "chart" and chart_folder:
                    log(f"  source a: chart {chart_folder}")
                    cand = align_chart(Path(chart_folder), sp, onsets=onsets, force_method=force_method, log=log)
                elif src == "gp":
                    log("  source b: GP drum track")
                    cand = gp_candidate(sp, gp_path, log=log)
                elif src.startswith("transcribe:"):
                    cand = transcribe_candidate(sp, src.split(":", 1)[1], log=log)
            except Exception as e:     # one bad source shouldn't stop the next
                log(f"  {src} failed: {e}")
                report["candidates"].append({"source": src, "error": str(e)})
                continue
            if cand is None:
                continue
            v = validate_candidate(cand, onsets, thresholds, bands)
            log(f"  {cand.source}: {len(cand.chart.hits)} notes, median offset {v.median_offset * 1000:+.0f} ms, "
                f"{v.within_30ms:.0%} within 30 ms, drift {v.drift_span * 1000:.0f} ms -> "
                f"{'OK' if v.ok else 'FLAGGED: ' + '; '.join(v.reasons)}")
            report["candidates"].append({"source": cand.source, **cand.detail, "validation": v.summary()})
            if v.ok:
                chosen = cand
                break
            if force and chosen is None:
                chosen = cand
        if chosen is not None and not dry_run and (chosen.validation.ok or force):
            chart = finalize_chart(chosen.chart, sp)
            src = {"source": chosen.source, **chosen.detail}
            arr = drumchart.drums_arrangement(chart, with_beats=False, source=src)
            x_drums = {"source": chosen.source, "validation": chosen.validation.summary(),
                       "joined": time.strftime("%Y-%m-%d %H:%M"), "forced": not chosen.validation.ok}
            write_drums(sp, arr, x_drums, backup_dir)
            report["written"] = chosen.source
            log(f"  wrote Drums ({chosen.source}, {len(chart.hits)} notes, {len(chart.star_power)} SP phrases)")
        elif chosen is None:
            log("  nothing written: no candidate passed validation (use --force to write the best anyway)")
    finally:
        sp.close()
    if report_path:
        Path(report_path).write_text(json.dumps(report, indent=1, default=float), encoding="utf-8")
    return report
