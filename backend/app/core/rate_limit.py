"""
A small sliding-window rate limiter, for the endpoints anyone can call —
raising a support ticket, posting to one.

In memory, per process. That is enough to stop a script flooding the support
queue from one address; a deployment behind several workers that needs a
shared limit would move `_hits` to Redis without changing the callers.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from typing import Deque, Dict

from app.core.errors import RateLimitedError

_hits: Dict[str, Deque[float]] = defaultdict(deque)
_lock = threading.Lock()


def check(key: str, *, limit: int, window_seconds: int, message: str = "") -> None:
    """Record one hit for `key`; refuse once there are `limit` inside the window."""
    now = time.monotonic()
    with _lock:
        hits = _hits[key]
        while hits and now - hits[0] > window_seconds:
            hits.popleft()
        if len(hits) >= limit:
            raise RateLimitedError(
                message or "You're doing that a little too often. Please wait a moment and try again."
            )
        hits.append(now)


def reset() -> None:
    """Forget every hit — for tests."""
    with _lock:
        _hits.clear()
