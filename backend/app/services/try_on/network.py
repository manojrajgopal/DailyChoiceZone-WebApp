"""
Reaching AI providers on networks with broken IPv6.

Some networks resolve a provider's IPv6 addresses but can't actually reach
them: the connection is reset ("WinError 10054", httpx `ConnectError`), while
IPv4 to the same host works every time. Python tries the addresses in the
order the resolver gives them, so every call becomes a coin toss — credential
checks report "provider unavailable" and generations fail for no reason of
theirs.

With `VTO_PREFER_IPV4` (on by default) the provider hosts below resolve to
their IPv4 addresses first, and only when they have some. Nothing else in the
application is affected, and it covers every library that talks to the
provider (httpx, gradio_client, huggingface_hub, websockets), since they all
resolve through `socket.getaddrinfo`.
"""

from __future__ import annotations

import socket
import threading

from app.core.config import settings

PROVIDER_SUFFIXES = ("huggingface.co", "hf.co", "hf.space")

_original = socket.getaddrinfo
_installed = False
_lock = threading.Lock()


def is_provider_host(host) -> bool:
    if not isinstance(host, str):
        host = host.decode() if isinstance(host, bytes) else ""
    host = host.lower().rstrip(".")
    return any(host == suffix or host.endswith("." + suffix) for suffix in PROVIDER_SUFFIXES)


def _prefer_ipv4(host, *args, **kwargs):
    results = _original(host, *args, **kwargs)
    if not settings.VTO_PREFER_IPV4 or not is_provider_host(host):
        return results
    ipv4 = [r for r in results if r[0] == socket.AF_INET]
    return ipv4 or results


def install() -> None:
    """Idempotent: wrap the resolver once per process."""
    global _installed
    with _lock:
        if _installed:
            return
        socket.getaddrinfo = _prefer_ipv4
        _installed = True
