"""
The interface every AI endpoint family implements.

An adapter knows how to call one kind of endpoint, which capabilities that
kind can *at most* handle (a model row narrows it further), how to check a
credential, and how to turn the provider's errors into catalogue codes. The
rest of the feature — selection, quota, storage, the portal — only ever talks
to this interface, so adding a provider is one new adapter class registered in
`adapters/__init__.py`, plus a provider and model row added in the portal.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import ClassVar, Optional, Tuple

from app.services.try_on.errors import ProviderFailure


@dataclass
class GenerationInput:
    capability: str
    # The customer's photo and the product photo, both normalised JPEG bytes.
    person: bytes
    garment: bytes
    request_id: str = ""


@dataclass
class GenerationOutput:
    data: bytes
    content_type: str = "image/jpeg"


@dataclass
class HealthResult:
    ok: bool
    code: str = ""
    detail: str = ""
    latency_ms: int = 0
    # Whatever the provider says about the account or its limits — never the secret.
    info: dict = field(default_factory=dict)


class TryOnAdapter:
    key: ClassVar[str] = ""
    provider_kind: ClassVar[str] = ""
    label: ClassVar[str] = ""
    description: ClassVar[str] = ""
    # The most this endpoint family can do. A model row lists a subset.
    max_capabilities: ClassVar[Tuple[str, ...]] = ()
    # The config keys an administrator may set on a model, with their meaning.
    config_fields: ClassVar[dict] = {}
    needs_secret: ClassVar[bool] = True
    development_only: ClassVar[bool] = False

    def generate(self, inputs: GenerationInput, *, secret: Optional[str], config: dict,
                 timeout: float) -> GenerationOutput:
        raise NotImplementedError

    def check_credential(self, secret: str, *, config: dict) -> HealthResult:
        raise NotImplementedError

    def classify(self, error: BaseException) -> ProviderFailure:
        if isinstance(error, ProviderFailure):
            return error
        if isinstance(error, TimeoutError):
            return ProviderFailure("timeout", str(error) or "timed out")
        return ProviderFailure("unknown", f"{type(error).__name__}: {error}")

    def describe(self) -> dict:
        return {
            "key": self.key,
            "providerKind": self.provider_kind,
            "label": self.label,
            "description": self.description,
            "maxCapabilities": list(self.max_capabilities),
            "configFields": self.config_fields,
            "needsSecret": self.needs_secret,
        }
