"""Re-key Rig Builder's knob table to its bundled pedal filenames.

Rig Builder v2 renamed its 100 bundled pedal VSTs (e.g. Chorus -> "CH-2.vst3"), but
rs_knob_to_vst_param.json is still keyed by the old names ("chorus"). The knob lookup goes by the
lowercased file stem, so for most pedals a song's Rocksmith knob values were never applied.

For every gear whose primary rs_gear_to_vst.json entry is a bundled pedal, this copies the
knob-map entry from the old key (the entry's "name", lowercased) to the new filename stem. Param
names were verified identical on the renamed plugins. Old keys are kept, so it is safe to re-run.

    python -I rekey_knob_table.py <rig_builder data dir> [--apply]

The data dir that counts is <config>/nam_rig_builder/data (the plugin copies its bundled data
there once and reads that copy); without --apply it only reports.
"""
import argparse
import json
import os
import shutil
import time


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("data_dir")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    gear_path = os.path.join(args.data_dir, "rs_gear_to_vst.json")
    knob_path = os.path.join(args.data_dir, "rs_knob_to_vst_param.json")
    gear = json.load(open(gear_path, encoding="utf-8"))
    knob = json.load(open(knob_path, encoding="utf-8"))

    added, already, unmapped = [], [], []
    for g, entries in gear.items():
        if g.startswith("_") or not isinstance(entries, list) or not entries:
            continue
        e = entries[0]
        if not isinstance(e, dict) or not e.get("bundled"):
            continue
        stem = os.path.splitext(os.path.basename(e["bundled"].replace("\\", "/")))[0].lower()
        km = knob.get(g)
        if not isinstance(km, dict):
            unmapped.append((g, stem))
            continue
        if stem in km:
            already.append(g)
            continue
        old = (e.get("name") or "").lower()
        if old in km:
            km[stem] = km[old]
            added.append((g, old, stem))
        else:
            unmapped.append((g, stem))

    print(f"{len(added)} re-keyed, {len(already)} already keyed, {len(unmapped)} with no knob map")
    for g, old, stem in added:
        print(f"  {g}: '{old}' -> '{stem}'")
    for g, stem in unmapped:
        print(f"  no knob map: {g} ({stem})")
    if args.apply and added:
        backup = f"{knob_path}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(knob_path, backup)
        meta = knob.setdefault("_meta", {})
        meta.setdefault("notes", []).append(
            "Re-keyed to bundled pedal filename stems by slopsmith-custom tools/rig_builder/rekey_knob_table.py")
        tmp = knob_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(knob, f, indent=2, ensure_ascii=False)
        os.replace(tmp, knob_path)
        print(f"wrote {knob_path} (backup {backup})")


if __name__ == "__main__":
    main()
