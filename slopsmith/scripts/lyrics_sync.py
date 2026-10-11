"""Timed lyrics for a sloppak from its own vocals stem (local Whisper speech recognition).

    python scripts/lyrics_sync.py SONG.sloppak... [--model large-v3] [--force] [--backup-dir DIR]

Transcribes stems/vocals.ogg with word timestamps and writes lyrics.json (Slopsmith's
[{"t", "d", "w"}] list; a word ending in "+" ends a line) plus manifest `lyrics:` and an
`x_lyrics` note saying they were machine-made. Nothing is fetched from the internet except the
Whisper model on first use. Songs that already have lyrics are skipped unless --force.
Words where the vocals stem is near-silent are dropped (Whisper invents text in instrumental
stretches). Prints counts only.

Run with _build/.mirvenv/Scripts/python.exe (openai-whisper installed --no-deps on the GPU torch).
"""
from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parent.parent
SR = 16000
LINE_GAP = 1.2      # s of silence that starts a new lyric line
LINE_MAX = 9        # words per line at most
SILENT_DB = -45.0   # word dropped when the vocals stem is quieter than this over its span


def vocals_member(z: zipfile.ZipFile, manifest: dict) -> str | None:
    for s in manifest.get("stems", []):
        if s.get("id") == "vocals" and s.get("file") in z.namelist():
            return s["file"]
    return "stems/vocals.ogg" if "stems/vocals.ogg" in z.namelist() else None


def word_db(audio: np.ndarray, t0: float, t1: float) -> float:
    a, b = int(t0 * SR), max(int(t1 * SR), int(t0 * SR) + 1)
    seg = audio[a:b]
    if not len(seg):
        return -120.0
    return float(20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9))


def voiced_start(audio: np.ndarray, t0: float, t1: float, thr_db=-40.0, hop=0.01) -> float:
    """Whisper stretches a word back over the silence before it (a first word "at 0.0 s"):
    move its start to the first 10 ms frame where the vocals stem gets loud."""
    t = t0
    while t < t1 - hop:
        if word_db(audio, t, t + hop) >= thr_db:
            return t
        t += hop
    return t0


def transcribe(model, audio: np.ndarray) -> list[dict]:
    res = model.transcribe(audio, language="en", word_timestamps=True, condition_on_previous_text=False,
                           temperature=0.0, no_speech_threshold=0.6, compression_ratio_threshold=2.4,
                           hallucination_silence_threshold=2.0, verbose=None)
    words = []
    for seg in res["segments"]:
        if seg.get("no_speech_prob", 0) > 0.6 and seg.get("avg_logprob", 0) < -1.0:
            continue
        for i, w in enumerate(seg.get("words") or []):
            text = w["word"].strip()
            if not text:
                continue
            t0, t1 = float(w["start"]), float(w["end"])
            if word_db(audio, t0, t1) < SILENT_DB:
                continue
            t0 = voiced_start(audio, t0, t1)
            words.append({"t": t0, "e": t1, "w": text, "p": float(w.get("probability", 0)),
                          "seg_end": i == len(seg["words"]) - 1})
    return words


def to_lyrics(words: list[dict]) -> list[dict]:
    out, n_in_line = [], 0
    for i, w in enumerate(words):
        nxt = words[i + 1] if i + 1 < len(words) else None
        n_in_line += 1
        end_line = (nxt is None or w["seg_end"] or nxt["t"] - w["e"] >= LINE_GAP or n_in_line >= LINE_MAX)
        text = w["w"] + ("+" if end_line else "")
        out.append({"t": round(w["t"], 3), "d": round(max(0.05, w["e"] - w["t"]), 3), "w": text})
        if end_line:
            n_in_line = 0
    return out


def write_sloppak(path: Path, manifest: dict, lyrics: list[dict], backup_dir: Path):
    backup_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup_dir / f"{path.stem}.{time.strftime('%Y%m%d-%H%M%S')}.sloppak")
    tmp = path.with_name(path.name + ".tmp")
    with zipfile.ZipFile(path) as src, zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as dst:
        for item in src.infolist():
            if item.filename in ("manifest.yaml", "lyrics.json"):
                continue
            dst.writestr(item, src.read(item.filename))
        dst.writestr("lyrics.json", json.dumps(lyrics, separators=(",", ":")))
        dst.writestr("manifest.yaml", yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True))
    tmp.replace(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sloppaks", nargs="+")
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--force", action="store_true", help="replace lyrics a song already has")
    ap.add_argument("--backup-dir", default=str(ROOT / "_build" / "backup"))
    ap.add_argument("--dry-run", action="store_true", help="transcribe and report, don't write")
    a = ap.parse_args()

    import whisper
    import torch
    model = None
    for p in map(Path, a.sloppaks):
        with zipfile.ZipFile(p) as z:
            manifest = yaml.safe_load(z.read("manifest.yaml"))
            if manifest.get("lyrics") and not a.force:
                print(f"{p.name}: has lyrics, skipped (--force replaces)")
                continue
            member = vocals_member(z, manifest)
            if not member:
                print(f"{p.name}: no vocals stem, skipped")
                continue
            with tempfile.TemporaryDirectory() as td:
                f = Path(td) / "vocals.ogg"
                f.write_bytes(z.read(member))
                audio = whisper.load_audio(str(f))
        if model is None:
            model = whisper.load_model(a.model, device="cuda" if torch.cuda.is_available() else "cpu")
        t0 = time.time()
        words = transcribe(model, audio)
        lyrics = to_lyrics(words)
        lines = sum(w["w"].endswith("+") for w in lyrics)
        conf = np.mean([w["p"] for w in words]) if words else 0.0
        span = f"{lyrics[0]['t']:.1f}-{lyrics[-1]['t']:.1f}s" if lyrics else "-"
        print(f"{p.name}: {len(lyrics)} words, {lines} lines, {span}, mean confidence {conf:.2f}, "
              f"{time.time() - t0:.0f}s")
        if a.dry_run or not lyrics:
            continue
        manifest["lyrics"] = "lyrics.json"
        manifest["x_lyrics"] = {"source": f"whisper {a.model} on stems/vocals (machine transcription)",
                                "words": len(lyrics), "mean_confidence": round(float(conf), 2),
                                "made": time.strftime("%Y-%m-%d")}
        write_sloppak(p, manifest, lyrics, Path(a.backup_dir))


if __name__ == "__main__":
    main()
