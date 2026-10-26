"""
An offline adapter for development and tests: no network, no credits.

It "tries on" by pasting the product photo over the middle of the customer's
photo — obviously not a real result, but a real image, so the whole flow
(queue, quota, storage, history, deletion) can be exercised end to end. A
model's config can make it fail on purpose: `{"fail": "rate_limited"}`, or
take its time: `{"delaySeconds": 3}`.

Never available in production, whatever the settings say.
"""

from __future__ import annotations

import io
import time
from typing import Optional

from PIL import Image

from app.core.config import settings
from app.services.try_on.adapters.base import GenerationInput, GenerationOutput, HealthResult, TryOnAdapter
from app.services.try_on.errors import ProviderFailure


def allowed() -> bool:
    return not settings.is_production and bool(settings.VTO_ALLOW_MOCK_PROVIDER)


class MockOverlay(TryOnAdapter):
    key = "mock.overlay"
    provider_kind = "mock"
    label = "Mock (development only)"
    description = "Pastes the product photo onto the customer's photo. For testing the flow without AI credits."
    max_capabilities = ("*",)
    config_fields = {"fail": "A failure code to raise every time.", "delaySeconds": "Seconds to wait."}
    # Runs without a credential; uses one when the provider has any.
    needs_secret = False
    development_only = True

    def generate(self, inputs: GenerationInput, *, secret: Optional[str], config: dict,
                 timeout: float) -> GenerationOutput:
        if not allowed():
            raise ProviderFailure("provider_unavailable", "the mock provider is not available here")
        delay = float(config.get("delaySeconds") or 0)
        if delay:
            time.sleep(min(delay, timeout))
        if config.get("fail"):
            raise ProviderFailure(str(config["fail"]), "mock failure requested by the model configuration")
        if secret and secret.startswith("invalid"):
            raise ProviderFailure("invalid_credentials", "mock: credential marked invalid")
        with Image.open(io.BytesIO(inputs.person)) as person, Image.open(io.BytesIO(inputs.garment)) as garment:
            canvas = person.convert("RGB")
            item = garment.convert("RGB")
            width = max(1, canvas.width // 2)
            item.thumbnail((width, width))
            canvas.paste(item, ((canvas.width - item.width) // 2, canvas.height // 4))
            out = io.BytesIO()
            canvas.save(out, format="JPEG", quality=88)
        return GenerationOutput(out.getvalue(), "image/jpeg")

    def check_credential(self, secret: str, *, config: dict) -> HealthResult:
        if secret.startswith("invalid"):
            return HealthResult(False, "invalid_credentials", "mock: credential marked invalid")
        return HealthResult(True, "", "mock credential accepted", 1, {"accountType": "mock"})
