"""native_midi.py: message decoding, timestamp anchoring and the shared-device hub (no MIDI hardware)."""

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("drums_native_midi", Path(__file__).resolve().parent.parent / "native_midi.py")
nm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nm)


def test_decode_short_message_lengths():
    assert nm.decode_short(0x99 | (38 << 8) | (100 << 16)) == [0x99, 38, 100]   # note on, ch 10
    assert nm.decode_short(0x89 | (38 << 8)) == [0x89, 38, 0]
    assert nm.decode_short(0xC9 | (5 << 8) | (77 << 16)) == [0xC9, 5]           # program change: 2 bytes
    assert nm.decode_short(0xF8) == [0xF8]                                     # clock: 1 byte


def test_anchor_uses_the_least_delayed_callback():
    a = nm._Anchor()
    # device ms -> callback perf s; the callbacks ran 10, 3 and 20 ms after the message arrived
    t1 = a.map(1000, 5.010)
    t2 = a.map(2000, 6.003)
    t3 = a.map(3000, 7.020)
    assert t1 == pytest.approx(5.010)            # only one sample so far
    assert t2 == pytest.approx(6.003)
    assert t3 == pytest.approx(7.003)            # the late callback is mapped back to the arrival


def test_anchor_window_forgets_old_samples():
    a = nm._Anchor()
    a.map(0, 1.000)                              # offset 1.000
    t = a.map(40000, 41.050)                     # 40 s later: the old sample is outside the window
    assert t == pytest.approx(41.050)


class FakeInput:
    opened = []

    def __init__(self, dev_id, listener):
        self.dev_id, self.listener, self.closed = dev_id, listener, False

    def open(self):
        FakeInput.opened.append(self)
        return self

    def close(self):
        self.closed = True


def test_hub_shares_one_device_and_closes_after_the_last_subscriber():
    FakeInput.opened = []
    hub = nm.Hub(FakeInput)
    got_a, got_b = [], []
    ta = hub.subscribe(3, lambda d, t: got_a.append(d))
    tb = hub.subscribe(3, lambda d, t: got_b.append(d))
    assert len(FakeInput.opened) == 1 and hub.is_open(3)
    FakeInput.opened[0].listener([0x99, 36, 90], 1.0)        # a message from the device
    hub.inject(3, [0x99, 38, 100])
    assert got_a == got_b == [[0x99, 36, 90], [0x99, 38, 100]]
    hub.unsubscribe(3, ta)
    assert not FakeInput.opened[0].closed
    hub.unsubscribe(3, tb)
    assert FakeInput.opened[0].closed and not hub.is_open(3)


def test_hub_open_failure_leaves_nothing_behind():
    class Broken(FakeInput):
        def open(self):
            raise OSError("midiInOpen failed (4)")

    hub = nm.Hub(Broken)
    with pytest.raises(OSError):
        hub.subscribe(1, lambda d, t: None)
    assert not hub.is_open(1)
