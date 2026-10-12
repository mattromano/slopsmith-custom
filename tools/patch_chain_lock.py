"""Chain lock: run the native signal-chain operations of Audio Engine, NAM Tone and Rig Builder one at
a time. Re-run after any of those plugins updates (already-patched calls are left alone).

    python -I tools/patch_chain_lock.py [BACKUP_DIR]

Why (2026-10-12): Slopsmith crashed 4x (10-09 .. 10-12), every time the same access violation in the
main process, on a Node worker thread inside slopsmith_audio.node (Crashpad dumps in
%APPDATA%/slopsmith-desktop/Crashpad/reports). The engine's async work (loadPreset / loadNAMModel /
loadIR / loadVST run as N-API async workers) is what runs on those threads, and the three plugins
each clearChain() + load presets on their own, with nothing stopping two of them (or two tone changes)
from rebuilding the chain at the same time. The bridge object (window.slopsmithDesktop.audio) is
read-only, so instead every `api.<op>(...)` call site becomes `window.__chainSer(api, '<op>')(...)`:
a queue that starts the next chain op only after the previous one finished (20 s safety timeout).
A small prelude defining window.__chainSer is put at the top of each patched file, so it works
whichever plugin loads first. window.__chainSer.stats counts calls / waits.
"""
import os
import re
import shutil
import sys
from pathlib import Path

P = Path(os.environ["APPDATA"]) / "slopsmith-desktop" / "plugins"
BACKUP = Path(sys.argv[1]) if len(sys.argv) > 1 else None
FILES = ["audio_engine/screen.js", "nam_tone/screen.js", "nam_rig_builder/screen.js"]
OPS = "loadPreset|clearChain|loadNAMModel|loadIR|loadVST|removeProcessor|moveProcessor"
CALL = re.compile(r"(?<![\w$.'])api\.(" + OPS + r")\(")
MARK = "/* chain-lock prelude (slopsmith-custom/tools/patch_chain_lock.py) */"
PRELUDE = MARK + r"""
(function () {
    if (window.__chainSer) return;
    let tail = Promise.resolve();
    const stats = { calls: 0, waited: 0, depth: 0, maxDepth: 0, timeouts: 0 };
    const ser = (obj, name) => (...args) => {
        stats.calls++;
        if (stats.depth > 0) stats.waited++;
        stats.depth++;
        stats.maxDepth = Math.max(stats.maxDepth, stats.depth);
        const run = () => { try { return Promise.resolve(obj[name](...args)); } catch (e) { return Promise.reject(e); } };
        const result = tail.then(run, run);
        tail = new Promise((done) => {
            const t = setTimeout(() => { stats.timeouts++; done(); }, 20000);
            const fin = () => { clearTimeout(t); done(); };
            result.then(fin, fin);
        }).then(() => { stats.depth--; });
        return result;
    };
    ser.stats = stats;
    window.__chainSer = ser;
})();
"""

for rel in FILES:
    f = P / rel
    if not f.exists():
        print(f"{rel}: not installed, skipped")
        continue
    raw = f.read_bytes().decode("utf-8")
    nl = "\r\n" if "\r\n" in raw else "\n"
    text = raw
    n = len(CALL.findall(text))
    text = CALL.sub(lambda m: f"window.__chainSer(api, '{m.group(1)}')(", text)
    if MARK not in text:
        text = PRELUDE.replace("\n", nl) + text
    if text == raw:
        print(f"{rel}: already patched")
        continue
    if BACKUP:
        (BACKUP / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, BACKUP / rel)
    f.write_bytes(text.encode("utf-8"))
    print(f"{rel}: {n} chain calls routed through the queue")
