"""Which payment provider is active.

Selected from configuration, so adding Razorpay is a class in this package and
one line in the map — nothing above it learns a provider's name.
"""

from __future__ import annotations

from functools import lru_cache

from app.core.config import settings
from app.services.payments.base import (
    PaymentProvider,
    PaymentRequest,
    PaymentResult,
    RefundResult,
)
from app.services.payments.mock import MockPaymentProvider

_PROVIDERS = {
    "mock": MockPaymentProvider,
    # "razorpay": RazorpayPaymentProvider,
    # "stripe": StripePaymentProvider,
}


@lru_cache
def get_provider() -> PaymentProvider:
    factory = _PROVIDERS.get(settings.PAYMENT_PROVIDER)
    if factory is None:
        raise RuntimeError(
            f"PAYMENT_PROVIDER is '{settings.PAYMENT_PROVIDER}', which is not implemented. "
            f"Available: {', '.join(sorted(_PROVIDERS))}."
        )
    return factory()


__all__ = [
    "PaymentProvider",
    "PaymentRequest",
    "PaymentResult",
    "RefundResult",
    "get_provider",
]
