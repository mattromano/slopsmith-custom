"""Apply a kit balance measurement (tools/sync-bench/balance.mjs OUT=balance.json) to the kits.

    python -I plugins/drums/tools/apply_balance.py balance.json

For each measured kit, every piece's correction (dB to reach the target mix) is added to what it has:
sampled kits -> the note "gain" in sounds/kits/<kit>/kit.json; General MIDI kits -> GM_NOTE_DB in
screen.js. Measure again afterwards: repeat until every piece is within the tolerance (balance.mjs
prints the remaining corrections).
"""

import json
import re
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent
SAMPLED = {"crocell", "virtuosity", "drs"}
MAX_DB = 12.0


def main(path):
    meas = json.loads(Path(path).read_text(encoding="utf-8"))
    js_path = PLUGIN_DIR / "screen.js"
    js = js_path.read_bytes().decode("utf-8")
    nl = "\r\n" if "\r\n" in js else "\n"
    m = re.search(r"const GM_NOTE_DB = (\{\}|\{.*?\r?\n\});", js, re.S)
    gm = {}
    if m and m.group(1) != "{}":   # the JS literal as JSON: quote keys, drop trailing commas
        gm = json.loads(re.sub(r",\s*}", "}", re.sub(r"(\w+):", r'"\1":', m.group(1))))
    for kit, notes in meas.items():
        if kit in SAMPLED:
            kp = PLUGIN_DIR / "sounds" / "kits" / kit / "kit.json"
            k = json.loads(kp.read_text(encoding="utf-8"))
            for note, r in notes.items():
                n = k["notes"].get(note)
                if not n:
                    continue
                g = float(n.get("gain", 1.0)) * 10 ** (r["db"] / 20)
                n["gain"] = round(min(4.0, max(10 ** (-MAX_DB / 20), g)), 3)
            kp.write_text(json.dumps(k, indent=1) + "\n", encoding="utf-8")
            print(f"{kit}: kit.json note gains updated")
        else:
            t = gm.setdefault(kit, {})
            for note, r in notes.items():
                t[note] = round(max(-MAX_DB, min(MAX_DB, t.get(note, 0.0) + r["db"])), 1)
            print(f"{kit}: GM_NOTE_DB updated")
    body = "{\n" + "".join(
        f"    {kit}: {{ " + ", ".join(f"{n}: {v}" for n, v in sorted(t.items(), key=lambda x: int(x[0]))) + " },\n"
        for kit, t in gm.items()) + "}"
    js = re.sub(r"const GM_NOTE_DB = (?:\{\}|\{.*?\r?\n\});", lambda _: "const GM_NOTE_DB = " + body.replace("\n", nl) + ";", js, count=1, flags=re.S)
    js_path.write_bytes(js.encode("utf-8"))


if __name__ == "__main__":
    main(sys.argv[1])
