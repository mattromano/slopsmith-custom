"""LAN relay: let other devices on the home network reach this Slopsmith.

The desktop app starts its server on 127.0.0.1 only, so a Mac or phone on the
same Wi-Fi can't open it. This relay listens on 0.0.0.0:<port> and pipes each
TCP connection (HTTP and WebSocket alike) to the local server. It runs in its
own thread with its own event loop, so it doesn't depend on uvicorn's loop and
can be started from plugin setup.

Only private / link-local / loopback peers are accepted: Slopsmith has no
login, so the relay must never serve the internet even if the port were
forwarded by a router.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
import sys
import threading

DEFAULT_PORT = 18765
GUEST_SOURCE_ADDR = "127.0.0.2"


def peer_allowed(host: str) -> bool:
    """True for home-network peers: private, link-local or loopback addresses."""
    try:
        ip = ipaddress.ip_address(str(host).split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_private or ip.is_loopback or ip.is_link_local


def server_port_from_argv(argv=None, default=None):
    """The app server's port from its uvicorn command line (`--port N`)."""
    argv = sys.argv if argv is None else argv
    for i, a in enumerate(argv):
        if a == "--port" and i + 1 < len(argv):
            try:
                return int(argv[i + 1])
            except ValueError:
                return default
        if a.startswith("--port="):
            try:
                return int(a.split("=", 1)[1])
            except ValueError:
                return default
    return default


def lan_addresses() -> list[str]:
    """This machine's private IPv4 addresses, the default-route one first."""
    out: list[str] = []
    try:
        # UDP "connect" sends nothing; it just picks the outgoing interface.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            out.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            out.append(info[4][0])
    except OSError:
        pass
    seen, result = set(), []
    for a in out:
        try:
            ip = ipaddress.ip_address(a)
        except ValueError:
            continue
        if a in seen or ip.is_loopback or not (ip.is_private or ip.is_link_local):
            continue
        seen.add(a)
        result.append(a)
    return result


class LanRelay:
    def __init__(self, target_host: str = "127.0.0.1"):
        self.target_host = target_host
        self.target_port: int | None = None
        self.port: int | None = None
        self.error: str | None = None
        self.connections = 0
        self.rejected = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: asyncio.base_events.Server | None = None
        self._writers: set = set()      # live connections (both sides), closed on stop
        self._lock = threading.Lock()

    @property
    def running(self) -> bool:
        return self._server is not None

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None:
            loop = asyncio.new_event_loop()
            threading.Thread(target=loop.run_forever, name="mp-lan-relay", daemon=True).start()
            self._loop = loop
        return self._loop

    async def _pipe(self, reader, writer):
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                writer.write(data)
                await writer.drain()
        except (ConnectionError, OSError, asyncio.CancelledError):
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def _handle(self, reader, writer):
        peer = writer.get_extra_info("peername") or ("", 0)
        if not peer_allowed(peer[0]):
            self.rejected += 1
            writer.close()
            return
        try:
            # Connect from 127.0.0.2 where the OS allows it (Windows/Linux treat
            # all of 127/8 as loopback) so the server can tell relayed guests
            # (127.0.0.2) from this computer's own browser (127.0.0.1).
            try:
                up_r, up_w = await asyncio.open_connection(
                    self.target_host, self.target_port, local_addr=(GUEST_SOURCE_ADDR, 0))
            except OSError:
                up_r, up_w = await asyncio.open_connection(self.target_host, self.target_port)
        except OSError:
            writer.close()
            return
        self.connections += 1
        self._writers.update((writer, up_w))
        try:
            await asyncio.gather(self._pipe(reader, up_w), self._pipe(up_r, writer))
        finally:
            self._writers.discard(writer)
            self._writers.discard(up_w)

    def start(self, port: int, target_port: int) -> None:
        """(Re)start listening on 0.0.0.0:port, relaying to target_host:target_port."""
        with self._lock:
            self._stop_locked()
            self.target_port = int(target_port)
            loop = self._ensure_loop()
            fut = asyncio.run_coroutine_threadsafe(
                asyncio.start_server(self._handle, host="0.0.0.0", port=int(port)), loop)
            try:
                self._server = fut.result(timeout=5)
                self.port = int(port)
                self.error = None
            except Exception as e:  # port in use, permission, ...
                self._server = None
                self.port = None
                self.error = f"{type(e).__name__}: {e}"
                raise

    def _stop_locked(self) -> None:
        srv, self._server = self._server, None
        self.port = None
        if srv is not None and self._loop is not None:
            async def _close():
                srv.close()            # stop accepting
                for w in list(self._writers):
                    try:
                        w.close()      # drop guests that are still connected
                    except Exception:
                        pass
                self._writers.clear()
            try:
                asyncio.run_coroutine_threadsafe(_close(), self._loop).result(timeout=5)
            except Exception:
                pass

    def stop(self) -> None:
        with self._lock:
            self._stop_locked()
