"""
"When will it arrive?" at checkout. See docs/shipping-and-suppliers.md, section 6.

The store's pincode table is the authority. The courier is asked only for a
pincode the store hasn't listed, and only when the default courier has
`checkoutServiceability` switched on: with a short timeout, and remembered per
pincode for a few hours. Whatever goes wrong with the courier, the answer is
"couldn't tell" (`serviceable: null`) and checkout carries on exactly as it
would without this.

Nothing here changes what the customer pays, and nothing here can refuse an
order: `serviceability.enforce` stays the only gate at order time.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Dict, Optional, Tuple

from sqlalchemy.orm import Session

from app.services import serviceability
from app.services.shipping import providers as provider_config
from app.services.shipping import registry
from app.services.shipping.base import ProviderError, Unsupported

logger = logging.getLogger(__name__)

COURIER_TIMEOUT_SECONDS = 4.0
CACHE_SECONDS = 6 * 3600
# A failed courier call is remembered briefly, so a busy checkout doesn't
# queue every customer behind a courier that is down.
FAILURE_CACHE_SECONDS = 300
# The nominal parcel weight for an estimate when no default package is set.
# Only for this estimate: a shipment always uses the weight the team enters.
ESTIMATE_WEIGHT_GRAMS = 500

_cache: Dict[Tuple[str, str, bool], Tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def reset_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _answer(pincode: str, source: str, serviceable, *, cod=None, eta=None, label: str = "",
            message: str = "") -> dict:
    return {"pincode": pincode, "source": source, "serviceable": serviceable, "codAvailable": cod,
            "etaDays": eta, "label": label, "message": message}


def _label(days: Optional[int]) -> str:
    return f"Delivery by {serviceability.estimate_label(days)}" if days else ""


def _from_store(result) -> dict:
    eta = None
    if result.serviceable and (result.min_days or result.max_days):
        low = result.min_days or result.max_days
        eta = {"min": low, "max": result.max_days or low}
    return _answer(result.pincode, "store", result.serviceable,
                   cod=result.serviceable and result.cod_available,
                   eta=eta, label=_label(result.max_days) if result.serviceable else "",
                   message="" if result.serviceable else result.reason)


def _courier_row(db: Session):
    """The default courier, when it may be asked at checkout; else None."""
    row = registry.default_row(db)
    if row is None or registry.adapter_class(row.code) is None:
        return None
    config = provider_config.settings_of(row)
    if not config.get("checkoutServiceability") or not config["origin"].get("pincode"):
        return None
    return row


def _ask_courier(row, pincode: str, cod: bool) -> dict:
    config = provider_config.settings_of(row)
    adapter = registry.adapter_for(row.code, row, timeout=COURIER_TIMEOUT_SECONDS)
    package = config.get("defaultPackage") or {}
    weight = package.get("weightGrams") if isinstance(package, dict) else None
    result = adapter.serviceability(pickup_pincode=config["origin"]["pincode"], delivery_pincode=pincode,
                                    weight_grams=int(weight or ESTIMATE_WEIGHT_GRAMS), cod=cod)
    if not result.serviceable or not result.options:
        return _answer(pincode, "courier", False, cod=False,
                       message="Our couriers don't reach this pincode yet.")
    days = [o.eta_days for o in result.options if o.eta_days]
    # The cheapest courier is the one usually booked: its estimate is the promise.
    cheapest = min(result.options, key=lambda o: o.rate)
    eta = {"min": min(days), "max": max(days)} if days else None
    return _answer(pincode, "courier", True, cod=any(o.cod_available for o in result.options), eta=eta,
                   label=_label(cheapest.eta_days or (eta["max"] if eta else None)))


def estimate(db: Session, pincode: str, *, cod: bool = False) -> dict:
    code = serviceability.normalise(pincode)[:10]
    store = serviceability.check(db, code)
    if not store.valid:
        return _answer(code, "none", False, message=store.reason)
    # Listed (either way), or the store delivers only to listed pincodes: the store has answered.
    if store.listed or not store.serviceable:
        return _from_store(store)

    row = _courier_row(db)
    if row is None:
        return _answer(code, "none", None)

    key = (row.code, code, bool(cod))
    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(key)
    if cached and cached[0] > now:
        return dict(cached[1])

    try:
        answer = _ask_courier(row, code, bool(cod))
        lifetime = CACHE_SECONDS
    except (ProviderError, Unsupported) as error:
        logger.info("Courier estimate for %s unavailable: %s", code, getattr(error, "code", "UNSUPPORTED"))
        answer, lifetime = _answer(code, "none", None), FAILURE_CACHE_SECONDS
    except Exception:  # noqa: BLE001 - an estimate must never break checkout
        logger.exception("Courier estimate for %s failed", code)
        answer, lifetime = _answer(code, "none", None), FAILURE_CACHE_SECONDS
    with _cache_lock:
        _cache[key] = (now + lifetime, answer)
    return dict(answer)
