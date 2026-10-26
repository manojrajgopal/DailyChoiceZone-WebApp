"""
The adapters the store can run, by key.

To add a provider or a new kind of try-on (eyewear alignment, wrist
placement…): write a `TryOnAdapter` subclass, add it here, then in the portal
add the provider (if new) and a model that uses the adapter, list the
capabilities it was verified for, and enable it. Nothing else changes.
"""

from __future__ import annotations

from typing import Dict, List

from app.services.try_on.adapters.base import (  # noqa: F401
    GenerationInput,
    GenerationOutput,
    HealthResult,
    TryOnAdapter,
)
from app.services.try_on.adapters.huggingface import OotdFullBody, OotdHalfBody
from app.services.try_on.adapters.mock import MockOverlay, allowed as mock_allowed

REGISTRY: Dict[str, TryOnAdapter] = {
    adapter.key: adapter for adapter in (OotdHalfBody(), OotdFullBody(), MockOverlay())
}


def get(key: str) -> TryOnAdapter:
    adapter = REGISTRY.get(key)
    if adapter is None or (adapter.development_only and not mock_allowed()):
        raise KeyError(key)
    return adapter


def available() -> List[dict]:
    return [a.describe() for a in REGISTRY.values() if not a.development_only or mock_allowed()]


def provider_kinds() -> List[str]:
    return sorted({a.provider_kind for a in REGISTRY.values() if not a.development_only or mock_allowed()})


def supports(adapter_key: str, capability: str) -> bool:
    adapter = REGISTRY.get(adapter_key)
    if adapter is None:
        return False
    return "*" in adapter.max_capabilities or capability in adapter.max_capabilities
