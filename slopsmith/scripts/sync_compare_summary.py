"""Summarise sync_compare.py results: per-song deltas and totals.

  python scripts/sync_compare_summary.py _build/sync_compare/*.json
"""
import json
import statistics as st
import sys
from pathlib import Path

rows = []
for p in sys.argv[1:]:
    for r in json.loads(Path(p).read_text(encoding="utf-8")):
        if "candidates" in r:
            rows.append(r)
if not rows:
    sys.exit("no results")


def c(r, name, key):
    return r["candidates"][name][key]


print(f"{len(rows)} songs\n")
print(f"{'song':<44} {'method':<15} {'lift base':>9} {'+beam':>6} {'d':>6}   {'hit base':>8} {'+beam':>6}  "
      f"{'iqr ms':>13}  {'moved':>6}  {'line+beam lift':>14}")
for r in sorted(rows, key=lambda r: c(r, "base+beam", "lift") - c(r, "base", "lift")):
    lb, lr = c(r, "base", "lift"), c(r, "base+beam", "lift")
    print(f"{(r['title'] or r['file'])[:44]:<44} {r['method'] or '':<15} {lb:>9.2f} {lr:>6.2f} {lr - lb:>+6.2f}   "
          f"{c(r, 'base', 'hit'):>8.1%} {c(r, 'base+beam', 'hit'):>6.1%}  "
          f"{c(r, 'base', 'iqr_ms'):>6.1f}->{c(r, 'base+beam', 'iqr_ms'):<6.1f} {c(r, 'base+beam', 'moved_ms'):>6.1f}  "
          f"{c(r, 'line+beam', 'lift'):>14.2f}")


def summary(group, label):
    if not group:
        return
    d_lift = [c(r, "base+beam", "lift") - c(r, "base", "lift") for r in group]
    d_hit = [c(r, "base+beam", "hit") - c(r, "base", "hit") for r in group]
    d_iqr = [c(r, "base+beam", "iqr_ms") - c(r, "base", "iqr_ms") for r in group]
    better = sum(x > 0.05 for x in d_lift)
    worse = sum(x < -0.05 for x in d_lift)
    print(f"\n{label} ({len(group)} songs)")
    print(f"  lift: median {st.median(d_lift):+.2f}, mean {st.mean(d_lift):+.2f}; better {better}, "
          f"worse {worse}, about the same {len(group) - better - worse}  (|change| > 0.05)")
    print(f"  hit:  median {st.median(d_hit):+.1%}, mean {st.mean(d_hit):+.1%}")
    print(f"  hit-offset spread (IQR): median change {st.median(d_iqr):+.1f} ms")
    lb = [c(r, "base", "lift") for r in group]
    ll = [c(r, "line", "lift") for r in group]
    llb = [c(r, "line+beam", "lift") for r in group]
    print(f"  median lift: base {st.median(lb):.2f}, base+beam {st.median([c(r, 'base+beam', 'lift') for r in group]):.2f}, "
          f"line {st.median(ll):.2f}, line+beam {st.median(llb):.2f}")
    rec = sum(c(r, "line+beam", "lift") >= c(r, "base", "lift") - 0.05 for r in group)
    print(f"  line+beam reaches base (within 0.05 lift) on {rec} of {len(group)}")


summary(rows, "All")
summary([r for r in rows if r["method"] == "beat-dtw"], "Builds that kept beat-DTW")
summary([r for r in rows if r["method"] == "constant-tempo"], "Builds that kept constant tempo")
