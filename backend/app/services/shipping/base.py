"""
The courier boundary.

Nothing outside `app/services/shipping/` names a courier. Each provider
implements `ShippingProvider`; an operation it can't perform raises
`Unsupported`, and the portal hides that action. See
docs/shipping-and-suppliers.md, section 3.

Results are plain dataclasses in the store's own vocabulary: weights in grams,
money in paise, statuses from `STATUSES`. The adapters translate to and from
the courier's API; nothing above them sees a courier's field names.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional

from app.services.fulfilment import workflow as _workflow

# The shipment vocabulary, in lifecycle order. Defined once, with the rules
# for moving between them, in `fulfilment/workflow.py`.
STATUSES = _workflow.SHIPMENT_STATUSES

STATUS_LABELS: Dict[str, str] = dict(_workflow.SHIPMENT_LABELS)

# No further courier movement is expected.
TERMINAL = set(_workflow.SHIPMENT_TERMINAL)
# Still with the store: a courier pickup hasn't happened, so cancelling is possible.
BEFORE_PICKUP = set(_workflow.SHIPMENT_BEFORE_PICKUP)


class ProviderError(Exception):
    """
    A courier call that didn't succeed.

    `transient` says whether trying again might work (a timeout, a 5xx, a rate
    limit) or not (bad credentials, an invalid address, an unserviceable
    pincode). The message is written for the store team and never contains a
    credential.
    """

    def __init__(self, message: str, *, transient: bool, code: str = "PROVIDER_ERROR", partial=None):
        super().__init__(message)
        self.message = message
        self.transient = transient
        self.code = code
        # What a multi-step operation did achieve before it failed (a courier
        # order created, its AWB not yet assigned): a `CreateResult`, or None.
        self.partial = partial


class Unsupported(Exception):
    """The provider can't do this operation at all (the Manual provider can't print labels)."""


@dataclass
class Address:
    name: str = ""
    phone: str = ""
    email: str = ""
    line1: str = ""
    line2: str = ""
    city: str = ""
    state: str = ""
    pincode: str = ""
    country: str = "India"


@dataclass
class PackageInfo:
    weight_grams: int
    length_cm: Optional[float] = None
    width_cm: Optional[float] = None
    height_cm: Optional[float] = None
    count: int = 1
    type: str = "box"


@dataclass
class ShipmentLine:
    name: str
    sku: str
    quantity: int
    unit_price: int  # paise
    hsn: str = ""


@dataclass
class CreateRequest:
    reference: str  # our shipment number, sent to the courier as its order id
    order_number: str
    order_date: datetime
    origin: Address
    destination: Address
    package: PackageInfo
    lines: List[ShipmentLine]
    declared_value: int  # paise
    cod: bool
    cod_amount: int  # paise
    service: str = ""
    courier_code: str = ""  # a specific courier, where the provider aggregates several
    # Already known from an earlier, interrupted attempt: skip the step that made it.
    provider_order_id: str = ""
    provider_shipment_id: str = ""
    # Manual provider: what the admin typed.
    awb: str = ""
    courier_name: str = ""
    # A retry after an attempt that may have reached the courier (a timeout):
    # look for the courier order by `reference` before creating it again.
    lookup_existing: bool = False


@dataclass
class CreateResult:
    provider_order_id: str = ""
    provider_shipment_id: str = ""
    awb: str = ""
    courier_name: str = ""
    courier_code: str = ""
    expected_delivery_at: Optional[datetime] = None
    label_url: str = ""
    tracking_url: str = ""


@dataclass
class RateOption:
    courier_code: str
    courier_name: str
    rate: int  # paise
    eta_days: Optional[int] = None
    estimated_delivery_at: Optional[datetime] = None
    cod_available: bool = False


@dataclass
class ServiceabilityResult:
    serviceable: bool
    options: List[RateOption] = field(default_factory=list)
    message: str = ""


@dataclass
class LabelResult:
    url: str


@dataclass
class PickupResult:
    scheduled_at: Optional[datetime] = None
    token: str = ""


@dataclass
class TrackingEvent:
    """One scan, normalised. `status` is "" when the courier's text isn't recognised."""

    status: str
    provider_status: str
    description: str
    location: str
    occurred_at: datetime
    provider_event_id: str = ""


@dataclass
class TrackingResult:
    status: str  # normalised current status, or "" if unknown
    provider_status: str
    events: List[TrackingEvent] = field(default_factory=list)
    expected_delivery_at: Optional[datetime] = None
    delivered_at: Optional[datetime] = None


@dataclass
class WebhookEvent:
    """A verified, parsed webhook delivery."""

    event_key: str  # unique per delivery: for de-duplication
    awb: str = ""
    provider_shipment_id: str = ""
    reference: str = ""  # our shipment number, when the courier echoes it
    status: str = ""
    provider_status: str = ""
    events: List[TrackingEvent] = field(default_factory=list)
    expected_delivery_at: Optional[datetime] = None
    # Courier fields only, safe to store for debugging.
    safe_payload: dict = field(default_factory=dict)


class WebhookRejected(Exception):
    """The delivery failed verification (missing or wrong token or signature)."""


class ShippingProvider:
    """
    What every courier adapter offers. Override what the courier supports;
    the rest raises `Unsupported`.

    `config` is the saved non-secret settings; `credentials` the decrypted
    secrets. Neither is ever logged.
    """

    code = ""
    name = ""
    description = ""
    environments = ("production",)
    # The credential fields the portal asks for: (key, label, secret?)
    credential_fields: tuple = ()
    required_credentials: tuple = ()
    # Whether a person types the AWB (Manual) rather than the courier assigning it.
    manual_awb = False

    def __init__(self, config: Optional[dict] = None, credentials: Optional[dict] = None,
                 environment: str = "production", timeout: Optional[float] = None):
        self.config = config or {}
        self.credentials = credentials or {}
        self.environment = environment
        # Seconds per courier call; None means settings.SHIPPING_HTTP_TIMEOUT_SECONDS.
        self.timeout = timeout

    def tracking_url(self, awb: str) -> str:
        """A public page where the parcel can be followed, when the courier has one."""
        return ""

    def configured(self) -> bool:
        """Every required credential is set."""
        return all(str(self.credentials.get(key) or "").strip() for key in self.required_credentials)

    # ------------------------------------------------------------- capability

    def supports(self) -> Dict[str, bool]:
        """Which operations this provider performs, for the portal's buttons."""
        base = ShippingProvider
        return {
            "rates": type(self).serviceability is not base.serviceability,
            "label": type(self).generate_label is not base.generate_label,
            "pickup": type(self).schedule_pickup is not base.schedule_pickup,
            "tracking": type(self).track is not base.track,
            "cancel": type(self).cancel_shipment is not base.cancel_shipment,
            "webhook": type(self).parse_webhook is not base.parse_webhook,
            "manualAwb": self.manual_awb,
        }

    def services(self) -> List[str]:
        return list(self.config.get("services") or [])

    # ------------------------------------------------------------ operations

    def test_connection(self) -> str:
        """A short success message; raises ProviderError when the credentials don't work."""
        raise Unsupported()

    def serviceability(self, *, pickup_pincode: str, delivery_pincode: str, weight_grams: int,
                       cod: bool) -> ServiceabilityResult:
        raise Unsupported()

    def create_shipment(self, request: CreateRequest) -> CreateResult:
        raise Unsupported()

    def generate_label(self, *, provider_shipment_id: str, awb: str) -> LabelResult:
        raise Unsupported()

    def schedule_pickup(self, *, provider_shipment_id: str, awb: str) -> PickupResult:
        raise Unsupported()

    def cancel_shipment(self, *, provider_order_id: str, provider_shipment_id: str, awb: str) -> None:
        raise Unsupported()

    def track(self, *, awb: str, provider_shipment_id: str = "") -> TrackingResult:
        raise Unsupported()

    def parse_webhook(self, headers: Dict[str, str], body: bytes) -> WebhookEvent:
        raise Unsupported()
