"""Direct MIDI input on Windows (WinMM via ctypes), for when the browser can't see the kit.

Why: with the Windows MIDI Service (MidiSrv, Windows 11 2025+) Chromium/Electron's Web MIDI can list no
devices at all (measured 2026-10-10 on Matt's PC: Electron 35 and Edge 154 list zero inputs and zero
outputs, while WinMM itself lists the Alesis Drum Module and opens it). This module reads the kit
through WinMM directly and hands each message to listeners with a precise timestamp.

Timestamps: WinMM gives each message the time (ms) since midiInStart, taken by the driver when the
message arrived, so it is not affected by how late Python gets to run the callback. It is mapped onto
time.perf_counter() with an anchor = the smallest (callback perf time - device time) seen in the last
30 s: the least-delayed callback, so the mapped time is when the message arrived, to ~1 ms.

Only standard library. On other platforms `available()` is False and nothing is opened.
"""

import ctypes
import sys
import threading
import time

MIM_OPEN, MIM_CLOSE, MIM_DATA, MIM_LONGDATA, MIM_ERROR = 0x3C1, 0x3C2, 0x3C3, 0x3C4, 0x3C5
CALLBACK_FUNCTION = 0x00030000
ANCHOR_WINDOW_S = 30.0


def available():
    return sys.platform == "win32"


if available():
    _winmm = ctypes.WinDLL("winmm")

    class MIDIINCAPSA(ctypes.Structure):
        _fields_ = [("wMid", ctypes.c_ushort), ("wPid", ctypes.c_ushort), ("vDriverVersion", ctypes.c_uint),
                    ("szPname", ctypes.c_char * 32), ("dwSupport", ctypes.c_uint)]

    _MidiInProc = ctypes.WINFUNCTYPE(None, ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)
    _winmm.midiInGetNumDevs.restype = ctypes.c_uint
    _winmm.midiInGetDevCapsA.argtypes = [ctypes.c_size_t, ctypes.POINTER(MIDIINCAPSA), ctypes.c_uint]
    _winmm.midiInGetDevCapsA.restype = ctypes.c_uint
    _winmm.midiInOpen.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_uint, _MidiInProc, ctypes.c_void_p, ctypes.c_uint]
    _winmm.midiInOpen.restype = ctypes.c_uint
    for _fn in ("midiInStart", "midiInStop", "midiInReset", "midiInClose"):
        getattr(_winmm, _fn).argtypes = [ctypes.c_void_p]
        getattr(_winmm, _fn).restype = ctypes.c_uint


def list_inputs():
    """[{id, name}] for every WinMM MIDI input (ANSI caps: the Unicode call fails for some devices)."""
    if not available():
        return []
    out = []
    for i in range(_winmm.midiInGetNumDevs()):
        caps = MIDIINCAPSA()
        if _winmm.midiInGetDevCapsA(i, ctypes.byref(caps), ctypes.sizeof(caps)) == 0:
            out.append({"id": i, "name": caps.szPname.decode("mbcs", "replace").strip() or f"MIDI input {i}"})
    return out


def decode_short(param1):
    """Packed WinMM short message -> list of MIDI bytes (1-3, by status)."""
    status = param1 & 0xFF
    d1, d2 = (param1 >> 8) & 0xFF, (param1 >> 16) & 0xFF
    hi = status & 0xF0
    if hi in (0xC0, 0xD0) or status in (0xF1, 0xF3):
        return [status, d1]
    if status >= 0xF8 or status in (0xF6,):
        return [status]
    return [status, d1, d2]


class _Anchor:
    """Maps device ms (since midiInStart) onto perf_counter seconds: min(cb - dev) over a window."""

    def __init__(self, now=time.perf_counter):
        self._now = now
        self._samples = []   # (perf_at_callback, cb - dev)

    def map(self, dev_ms, cb_perf):
        d = cb_perf - dev_ms / 1000.0
        self._samples.append((cb_perf, d))
        cut = cb_perf - ANCHOR_WINDOW_S
        while len(self._samples) > 1 and self._samples[0][0] < cut:
            self._samples.pop(0)
        return min(s[1] for s in self._samples) + dev_ms / 1000.0


class MidiInput:
    """One open WinMM input. listener(data: list[int], t_perf: float) is called on a WinMM thread."""

    def __init__(self, dev_id, listener):
        self.dev_id = int(dev_id)
        self._listener = listener
        self._handle = ctypes.c_void_p()
        self._anchor = _Anchor()
        self._cb = _MidiInProc(self._on_msg)   # keep a reference: WinMM calls it later
        self.error = None
        self.messages = 0

    def _on_msg(self, h, msg, inst, p1, p2):
        if msg != MIM_DATA:
            return
        cb = time.perf_counter()
        try:
            t = self._anchor.map(int(p2 or 0), cb)
            self.messages += 1
            self._listener(decode_short(int(p1 or 0)), t)
        except Exception as e:   # never raise into WinMM
            self.error = str(e)

    def open(self):
        r = _winmm.midiInOpen(ctypes.byref(self._handle), self.dev_id, self._cb, None, CALLBACK_FUNCTION)
        if r != 0:
            raise OSError(f"midiInOpen failed ({r}): the device is missing or another program has it open")
        r = _winmm.midiInStart(self._handle)
        if r != 0:
            _winmm.midiInClose(self._handle)
            raise OSError(f"midiInStart failed ({r})")
        return self

    def close(self):
        if self._handle:
            try:
                _winmm.midiInStop(self._handle)
                _winmm.midiInReset(self._handle)
                _winmm.midiInClose(self._handle)
            finally:
                self._handle = ctypes.c_void_p()


class Hub:
    """Shares one open device between any number of subscribers; closes it when the last one leaves.

    subscribe(dev_id, fn) -> token; fn(data, t_perf) runs on the WinMM thread (callers hop to their
    own loop). inject(dev_id, data) feeds a message through the same path (tests).
    """

    def __init__(self, opener=MidiInput):
        self._opener = opener
        self._lock = threading.Lock()
        self._devs = {}   # dev_id -> {"input": MidiInput, "subs": {token: fn}}
        self._next = 1

    def _dispatch(self, dev_id, data, t):
        with self._lock:
            subs = list(self._devs.get(dev_id, {}).get("subs", {}).values())
        for fn in subs:
            try:
                fn(data, t)
            except Exception:
                pass

    def subscribe(self, dev_id, fn):
        dev_id = int(dev_id)
        with self._lock:
            ent = self._devs.get(dev_id)
            if ent is None:
                inp = self._opener(dev_id, lambda data, t, d=dev_id: self._dispatch(d, data, t)).open()
                ent = self._devs[dev_id] = {"input": inp, "subs": {}}
            token = self._next
            self._next += 1
            ent["subs"][token] = fn
            return token

    def unsubscribe(self, dev_id, token):
        dev_id = int(dev_id)
        with self._lock:
            ent = self._devs.get(dev_id)
            if not ent:
                return
            ent["subs"].pop(token, None)
            if not ent["subs"]:
                self._devs.pop(dev_id, None)
                inp = ent["input"]
            else:
                inp = None
        if inp is not None:
            inp.close()

    def inject(self, dev_id, data):
        self._dispatch(int(dev_id), list(data), time.perf_counter())

    def is_open(self, dev_id):
        with self._lock:
            return int(dev_id) in self._devs
