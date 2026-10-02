"""
Shiprocket (https://apiv2.shiprocket.in/v1/external).

Bearer-token auth: `POST /auth/login` with the account's API user email and
password returns a token valid for ten days. It is cached in this process,
keyed by the account, and renewed after nine days or on a 401 (once).

Every answer is read defensively. A field that is missing or of the wrong
shape is a non-transient `ProviderError` ("an unexpected answer"), never a
KeyError and never a 500. Timeouts, connection failures, 5xx and 429 are
transient; other 4xx are not. Credentials never appear in an error message
or a log line.

Tests replace `TRANSPORT` with an `httpx.MockTransport`; nothing else about
the HTTP layer is faked.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import threading
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import settings
from app.services.shipping.base import (
    CreateRequest,
    CreateResult,
    LabelResult,
    PickupResult,
    ProviderError,
    RateOption,
    ServiceabilityResult,
    ShippingProvider,
    TrackingEvent,
    TrackingResult,
    WebhookEvent,
    WebhookRejected,
)

# Replaced by tests with an httpx.MockTransport. None: the real network.
TRANSPORT: Optional[httpx.BaseTransport] = None

TOKEN_LIFETIME_SECONDS = 9 * 24 * 3600
_tokens: Dict[str, tuple] = {}
_tokens_lock = threading.Lock()


def reset_tokens() -> None:
    """Forget every cached token (tests, or after the credentials change)."""
    with _tokens_lock:
        _tokens.clear()


# ----------------------------------------------------------- status mapping

_RULES = [
    # Order matters: the first rule that matches wins.
    (re.compile(r"\bRTO\b|RETURN(ED)? TO ORIGIN"), "returned-to-origin"),
    (re.compile(r"CANCEL"), "cancelled"),
    (re.compile(r"UNDELIVERED|DELIVERY ATTEMPT|\bNDR\b"), "delivery-attempted"),
    (re.compile(r"\bLOST\b|DAMAGED|DESTROYED"), "delivery-failed"),
    (re.compile(r"OUT FOR DELIVERY"), "out-for-delivery"),
    (re.compile(r"DELIVERED"), "delivered"),
    (re.compile(r"REACHED (AT )?DESTINATION|DESTINATION HUB"), "at-destination-hub"),
    (re.compile(r"OUT FOR PICKUP|PICKUP SCHEDULED|PICKUP GENERATED|PICKUP QUEUED|PICKUP RESCHEDULED"),
     "pickup-scheduled"),
    (re.compile(r"PICKED UP|PICKUP COMPLETE"), "picked-up"),
    (re.compile(r"IN TRANSIT|\bSHIPPED\b"), "in-transit"),
    (re.compile(r"AWB ASSIGNED|LABEL GENERATED|MANIFEST GENERATED|READY TO SHIP"), "ready-for-pickup"),
]


def map_status(text: Any) -> str:
    """Courier status text to the shipment vocabulary; "" when it isn't recognised."""
    if not isinstance(text, str):
        return ""
    normal = re.sub(r"[\s_\-]+", " ", text.strip().upper())
    if not normal:
        return ""
    for pattern, status in _RULES:
        if pattern.search(normal):
            return status
    return ""


# ------------------------------------------------------------------ parsing

_DATE_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%d",
    "%d %m %Y %H:%M:%S",
    "%d-%m-%Y %H:%M:%S",
    "%d-%m-%Y %H:%M",
    "%d-%m-%Y",
    "%d/%m/%Y %H:%M:%S",
    "%d/%m/%Y",
    "%b %d, %Y",
    "%d %b %Y",
    "%d %b, %Y",
)


def parse_date(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    text = re.sub(r"(Z|[+-]\d\d:?\d\d)$", "", text)
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _text(value: Any, limit: int = 200) -> str:
    if value is None:
        return ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def _ident(value: Any) -> str:
    """An id the courier sent as a number or a string."""
    if isinstance(value, bool):
        return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, str) and value.strip():
        return value.strip()[:64]
    return ""


def _unexpected(what: str) -> ProviderError:
    return ProviderError(f"Shiprocket sent an unexpected answer ({what}).", transient=False,
                         code="UNEXPECTED_ANSWER")


def _dict(value: Any, what: str) -> dict:
    if not isinstance(value, dict):
        raise _unexpected(what)
    return value


def _rupees_to_paise(value: Any) -> Optional[int]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number < 0:  # NaN
        return None
    return int(round(number * 100))


def _int(value: Any) -> Optional[int]:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _scan(raw: Any) -> Optional[TrackingEvent]:
    """One scan from a tracking answer or a webhook, or None when it carries nothing usable."""
    if not isinstance(raw, dict):
        return None
    label = _text(raw.get("sr-status-label"), 120)
    status_text = _text(raw.get("status"), 120)
    activity = _text(raw.get("activity"), 500)
    location = _text(raw.get("location"), 160)
    raw_date = _text(raw.get("date"), 40)
    if not (label or status_text or activity):
        return None
    status = map_status(label) or map_status(status_text) or map_status(activity)
    occurred = parse_date(raw_date)
    event_id = ""
    if occurred is None:
        # Unreadable time: keep the event stable for de-duplication by its raw text.
        occurred = datetime.utcnow().replace(microsecond=0)
        event_id = hashlib.sha1(f"{raw_date}|{label or status_text}|{activity}|{location}".encode()).hexdigest()
    provider_status = label if label and label.upper() not in ("NA", "N/A") else (status_text or activity[:120])
    return TrackingEvent(status=status, provider_status=provider_status[:120], description=activity or provider_status,
                         location=location, occurred_at=occurred, provider_event_id=event_id)


# ----------------------------------------------------------------- adapter


class ShiprocketProvider(ShippingProvider):
    code = "shiprocket"
    name = "Shiprocket"
    description = "Book, label, schedule pickups and track with any courier on your Shiprocket account."
    environments = ("production",)
    credential_fields = (
        ("email", "API user email", False),
        ("password", "API user password", True),
        ("webhookToken", "Webhook token (x-api-key)", True),
    )
    required_credentials = ("email", "password")

    # ------------------------------------------------------------ transport

    def _timeout(self) -> float:
        return float(self.timeout if self.timeout is not None else settings.SHIPPING_HTTP_TIMEOUT_SECONDS)

    def _base(self) -> str:
        return (settings.SHIPROCKET_BASE_URL or "https://apiv2.shiprocket.in/v1/external").rstrip("/")

    def _cache_key(self) -> str:
        email = str(self.credentials.get("email") or "").strip().lower()
        password = str(self.credentials.get("password") or "")
        digest = hashlib.sha256(f"{self._base()}|{email}|{password}".encode()).hexdigest()
        return digest

    def _scrub(self, message: str) -> str:
        """Never let a credential through in a message, even one the courier echoed."""
        for key in ("password", "webhookToken", "email"):
            value = str(self.credentials.get(key) or "")
            if len(value) >= 4:
                message = message.replace(value, "[hidden]")
        return message

    def _send(self, method: str, path: str, *, token: Optional[str], json_body=None, params=None) -> httpx.Response:
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            with httpx.Client(timeout=self._timeout(), transport=TRANSPORT) as client:
                return client.request(method, f"{self._base()}{path}", json=json_body, params=params,
                                      headers=headers)
        except httpx.TimeoutException:
            raise ProviderError("Shiprocket didn't answer in time. It will be tried again.", transient=True,
                                code="TIMEOUT") from None
        except httpx.HTTPError:
            raise ProviderError("Shiprocket couldn't be reached. It will be tried again.", transient=True,
                                code="UNREACHABLE") from None

    @staticmethod
    def _body(response: httpx.Response) -> Any:
        try:
            return response.json()
        except (ValueError, json.JSONDecodeError):
            return None

    def _message(self, body: Any) -> str:
        if isinstance(body, dict):
            message = body.get("message")
            if isinstance(message, str) and message.strip():
                return self._scrub(message.strip())[:300]
            errors = body.get("errors")
            if isinstance(errors, dict):
                parts = []
                for value in errors.values():
                    if isinstance(value, list):
                        parts.extend(str(v) for v in value if isinstance(v, (str, int)))
                    elif isinstance(value, str):
                        parts.append(value)
                if parts:
                    return self._scrub("; ".join(parts))[:300]
        return ""

    def _login(self) -> str:
        email = str(self.credentials.get("email") or "").strip()
        password = str(self.credentials.get("password") or "")
        if not email or not password:
            raise ProviderError("Enter the Shiprocket API user email and password first.", transient=False,
                                code="CREDENTIALS_MISSING")
        response = self._send("POST", "/auth/login", token=None, json_body={"email": email, "password": password})
        body = self._body(response)
        if response.status_code in (400, 401, 403):
            raise ProviderError("Shiprocket rejected the credentials. Check the API user email and password.",
                                transient=False, code="CREDENTIALS_REJECTED")
        if response.status_code == 429 or response.status_code >= 500:
            raise ProviderError(f"Shiprocket is having trouble right now ({response.status_code}).",
                                transient=True, code="UNAVAILABLE")
        if response.status_code >= 400:
            raise ProviderError(self._message(body) or f"Shiprocket refused the sign-in ({response.status_code}).",
                                transient=False, code="CREDENTIALS_REJECTED")
        token = body.get("token") if isinstance(body, dict) else None
        if not isinstance(token, str) or not token.strip():
            raise _unexpected("no token after sign-in")
        with _tokens_lock:
            _tokens[self._cache_key()] = (token.strip(), time.monotonic() + TOKEN_LIFETIME_SECONDS)
        return token.strip()

    def _token(self) -> str:
        key = self._cache_key()
        with _tokens_lock:
            cached = _tokens.get(key)
        if cached and cached[1] > time.monotonic():
            return cached[0]
        return self._login()

    def _forget_token(self) -> None:
        with _tokens_lock:
            _tokens.pop(self._cache_key(), None)

    def _call(self, method: str, path: str, *, json_body=None, params=None, allow_404: bool = False) -> Any:
        """An authenticated call. Returns the decoded JSON body (any shape); raises ProviderError."""
        response = self._send(method, path, token=self._token(), json_body=json_body, params=params)
        if response.status_code == 401:
            # The token expired early or was revoked: sign in again, once.
            self._forget_token()
            response = self._send(method, path, token=self._login(), json_body=json_body, params=params)
            if response.status_code == 401:
                self._forget_token()
                raise ProviderError("Shiprocket rejected the credentials.", transient=False,
                                    code="CREDENTIALS_REJECTED")
        body = self._body(response)
        if response.status_code == 429:
            raise ProviderError("Shiprocket is limiting requests right now. It will be tried again.",
                                transient=True, code="RATE_LIMITED")
        if response.status_code >= 500:
            raise ProviderError(f"Shiprocket is having trouble right now ({response.status_code}). "
                                "It will be tried again.", transient=True, code="UNAVAILABLE")
        if response.status_code == 404 and allow_404:
            return body if body is not None else {}
        if response.status_code >= 400:
            message = self._message(body) or f"Shiprocket refused the request ({response.status_code})."
            raise ProviderError(message, transient=False, code="REFUSED")
        if body is None:
            raise _unexpected("not JSON")
        return body

    # ---------------------------------------------------------- operations

    def tracking_url(self, awb: str) -> str:
        return f"https://shiprocket.co/tracking/{awb}" if awb else ""

    def test_connection(self) -> str:
        self._forget_token()
        self._login()
        return "Connected to Shiprocket."

    def serviceability(self, *, pickup_pincode: str, delivery_pincode: str, weight_grams: int,
                       cod: bool) -> ServiceabilityResult:
        params = {
            "pickup_postcode": pickup_pincode,
            "delivery_postcode": delivery_pincode,
            "weight": f"{max(1, int(weight_grams)) / 1000:.3f}",
            "cod": 1 if cod else 0,
        }
        body = self._call("GET", "/courier/serviceability/", params=params, allow_404=True)
        body = _dict(body, "serviceability")
        data = body.get("data")
        companies = data.get("available_courier_companies") if isinstance(data, dict) else None
        if companies is None:
            status = _int(body.get("status"))
            if status == 404 or "message" in body:
                return ServiceabilityResult(serviceable=False, options=[],
                                            message=self._message(body) or "No courier serves this pincode.")
            raise _unexpected("no courier list")
        if not isinstance(companies, list):
            raise _unexpected("courier list")
        options: List[RateOption] = []
        for company in companies:
            if not isinstance(company, dict):
                continue
            code = _ident(company.get("courier_company_id"))
            name = _text(company.get("courier_name"), 120)
            rate = _rupees_to_paise(company.get("rate"))
            if not code or not name or rate is None:
                continue
            options.append(RateOption(
                courier_code=code, courier_name=name, rate=rate,
                eta_days=_int(company.get("estimated_delivery_days")),
                estimated_delivery_at=parse_date(company.get("etd")),
                cod_available=bool(_int(company.get("cod")) or company.get("cod") is True),
            ))
        if companies and not options:
            raise _unexpected("courier options")
        return ServiceabilityResult(serviceable=bool(options), options=options,
                                    message="" if options else "No courier serves this pincode.")

    def _order_payload(self, request: CreateRequest) -> dict:
        pickup = str(self.config.get("pickupLocation") or "").strip()
        if not pickup:
            raise ProviderError("Set the Shiprocket pickup location in the courier settings.", transient=False,
                                code="PICKUP_LOCATION_REQUIRED")
        package = request.package
        if not package.weight_grams or not (package.length_cm and package.width_cm and package.height_cm):
            raise ProviderError("Shiprocket needs the package weight and dimensions.", transient=False,
                                code="PACKAGE_REQUIRED")
        dest = request.destination
        first, _, last = (dest.name or "").strip().partition(" ")
        return {
            "order_id": request.reference,
            "order_date": request.order_date.strftime("%Y-%m-%d %H:%M"),
            "pickup_location": pickup,
            "billing_customer_name": first or dest.name,
            "billing_last_name": last,
            "billing_address": dest.line1,
            "billing_address_2": dest.line2,
            "billing_city": dest.city,
            "billing_pincode": dest.pincode,
            "billing_state": dest.state,
            "billing_country": dest.country or "India",
            "billing_email": dest.email,
            "billing_phone": dest.phone,
            "shipping_is_billing": True,
            "order_items": [
                {"name": line.name, "sku": line.sku or line.name[:40], "units": line.quantity,
                 "selling_price": round(line.unit_price / 100, 2), "discount": 0, "tax": 0, "hsn": line.hsn}
                for line in request.lines
            ],
            "payment_method": "COD" if request.cod else "Prepaid",
            "sub_total": round((request.cod_amount if request.cod else request.declared_value) / 100, 2),
            "length": float(package.length_cm),
            "breadth": float(package.width_cm),
            "height": float(package.height_cm),
            "weight": round(package.weight_grams / 1000, 3),
        }

    @staticmethod
    def _ids_from(body: Any) -> tuple:
        if not isinstance(body, dict):
            return "", ""
        for source in (body, body.get("data") if isinstance(body.get("data"), dict) else {}):
            order_id = _ident(source.get("order_id"))
            shipment_id = _ident(source.get("shipment_id"))
            if order_id and shipment_id:
                return order_id, shipment_id
        return "", ""

    def find_order(self, reference: str) -> tuple:
        """
        The courier order already created for `reference` (our shipment
        number, sent as `order_id`), as (order id, shipment id), or ("", "").

        Uses the order list's search (`GET /orders?search=`), matching the
        channel order id exactly.
        """
        body = self._call("GET", "/orders", params={"search": reference}, allow_404=True)
        rows = body.get("data") if isinstance(body, dict) else None
        if not isinstance(rows, list):
            return "", ""
        for row in rows:
            if not isinstance(row, dict) or _text(row.get("channel_order_id"), 64) != reference:
                continue
            order_id = _ident(row.get("id"))
            shipments = row.get("shipments")
            shipment_id = ""
            if isinstance(shipments, list) and shipments and isinstance(shipments[0], dict):
                shipment_id = _ident(shipments[0].get("id"))
            elif isinstance(shipments, dict):
                shipment_id = _ident(shipments.get("id"))
            if order_id and shipment_id:
                return order_id, shipment_id
        return "", ""

    def _create_order(self, request: CreateRequest) -> tuple:
        payload = self._order_payload(request)
        if request.lookup_existing:
            found = self.find_order(request.reference)
            if found[0]:
                return found
        try:
            body = self._call("POST", "/orders/create/adhoc", json_body=payload)
        except ProviderError as error:
            # Created by an earlier attempt that timed out: read the ids back.
            if not error.transient and "exist" in error.message.lower():
                found = self.find_order(request.reference)
                if found[0]:
                    return found
            raise
        order_id, shipment_id = self._ids_from(body)
        if not order_id or not shipment_id:
            raise ProviderError(self._message(body) or "Shiprocket didn't return the order and shipment ids.",
                                transient=False, code="UNEXPECTED_ANSWER")
        return order_id, shipment_id

    def _assign_awb(self, shipment_id: str, courier_code: str) -> dict:
        payload: Dict[str, Any] = {"shipment_id": int(shipment_id) if shipment_id.isdigit() else shipment_id}
        if courier_code and courier_code.isdigit():
            payload["courier_id"] = int(courier_code)
        body = _dict(self._call("POST", "/courier/assign/awb", json_body=payload), "AWB assignment")
        response = body.get("response")
        data = response.get("data") if isinstance(response, dict) else None
        status = body.get("awb_assign_status")
        if not isinstance(data, dict) or (status is not None and _int(status) != 1):
            reason = ""
            if isinstance(data, dict):
                reason = _text(data.get("awb_assign_error"), 300)
            raise ProviderError(self._scrub(reason or self._message(body) or "Shiprocket couldn't assign an AWB."),
                                transient=False, code="AWB_NOT_ASSIGNED")
        awb = _ident(data.get("awb_code"))
        if not awb:
            raise ProviderError(self._scrub(_text(data.get("awb_assign_error"), 300)
                                            or "Shiprocket didn't return an AWB."),
                                transient=False, code="AWB_NOT_ASSIGNED")
        return {"awb": awb, "courier_name": _text(data.get("courier_name"), 120),
                "courier_code": _ident(data.get("courier_company_id"))}

    def create_shipment(self, request: CreateRequest) -> CreateResult:
        order_id, shipment_id = request.provider_order_id, request.provider_shipment_id
        if not shipment_id:
            order_id, shipment_id = self._create_order(request)
        partial = CreateResult(provider_order_id=order_id, provider_shipment_id=shipment_id)
        try:
            assigned = self._assign_awb(shipment_id, request.courier_code)
        except ProviderError as error:
            error.partial = partial
            raise
        return CreateResult(provider_order_id=order_id, provider_shipment_id=shipment_id, awb=assigned["awb"],
                            courier_name=assigned["courier_name"], courier_code=assigned["courier_code"],
                            tracking_url=self.tracking_url(assigned["awb"]))

    @staticmethod
    def _id_list(provider_shipment_id: str) -> list:
        return [int(provider_shipment_id) if provider_shipment_id.isdigit() else provider_shipment_id]

    def generate_label(self, *, provider_shipment_id: str, awb: str) -> LabelResult:
        body = _dict(self._call("POST", "/courier/generate/label",
                                json_body={"shipment_id": self._id_list(provider_shipment_id)}), "label")
        url = body.get("label_url")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            message = self._message(body) or _text(body.get("response"), 300)
            if message:
                raise ProviderError(message, transient=False, code="LABEL_FAILED")
            raise _unexpected("no label link")
        return LabelResult(url=url[:1000])

    def schedule_pickup(self, *, provider_shipment_id: str, awb: str) -> PickupResult:
        body = _dict(self._call("POST", "/courier/generate/pickup",
                                json_body={"shipment_id": self._id_list(provider_shipment_id)}), "pickup")
        response = body.get("response")
        if not isinstance(response, dict):
            message = self._message(body)
            if message:
                raise ProviderError(message, transient=False, code="PICKUP_FAILED")
            raise _unexpected("pickup")
        if _int(body.get("pickup_status")) == 0:
            raise ProviderError(self._message(body) or "Shiprocket couldn't schedule the pickup.", transient=False,
                                code="PICKUP_FAILED")
        scheduled = parse_date(response.get("pickup_scheduled_date"))
        token = _text(response.get("pickup_token_number"), 64)
        if scheduled is None and not token:
            raise _unexpected("pickup date")
        return PickupResult(scheduled_at=scheduled, token=token)

    def cancel_shipment(self, *, provider_order_id: str, provider_shipment_id: str, awb: str) -> None:
        if not provider_order_id:
            return None  # nothing was created at the courier
        ids = [int(provider_order_id) if provider_order_id.isdigit() else provider_order_id]
        self._call("POST", "/orders/cancel", json_body={"ids": ids})
        return None

    def track(self, *, awb: str, provider_shipment_id: str = "") -> TrackingResult:
        if not awb:
            raise ProviderError("This shipment has no AWB to track yet.", transient=False, code="NO_AWB")
        body = self._call("GET", f"/courier/track/awb/{awb}", allow_404=True)
        # Seen both as {"tracking_data": {...}} and as [{"<awb>": {"tracking_data": {...}}}].
        if isinstance(body, list) and body and isinstance(body[0], dict):
            body = body[0].get(awb, body[0])
        body = _dict(body, "tracking")
        data = body.get("tracking_data")
        if not isinstance(data, dict):
            if "message" in body:
                return TrackingResult(status="", provider_status="", events=[])
            raise _unexpected("no tracking data")
        tracks = data.get("shipment_track")
        current = tracks[0] if isinstance(tracks, list) and tracks and isinstance(tracks[0], dict) else {}
        provider_status = _text(current.get("current_status"), 120)
        activities = data.get("shipment_track_activities")
        if activities is not None and not isinstance(activities, list):
            raise _unexpected("tracking activities")
        events = [e for e in (_scan(raw) for raw in (activities or [])) if e is not None]
        events.sort(key=lambda e: e.occurred_at)
        status = map_status(provider_status)
        delivered = parse_date(current.get("delivered_date")) if status == "delivered" else None
        return TrackingResult(status=status, provider_status=provider_status, events=events,
                              expected_delivery_at=parse_date(current.get("edd")) or parse_date(data.get("etd")),
                              delivered_at=delivered)

    # -------------------------------------------------------------- webhook

    SAFE_FIELDS = ("awb", "courier_name", "current_status", "current_status_id", "shipment_status",
                   "shipment_status_id", "current_timestamp", "order_id", "sr_order_id", "etd", "is_return",
                   "channel_id", "pod_status")
    SAFE_SCAN_FIELDS = ("date", "status", "activity", "location", "sr-status", "sr-status-label")

    def parse_webhook(self, headers: Dict[str, str], body: bytes) -> WebhookEvent:
        expected = str(self.credentials.get("webhookToken") or "")
        given = ""
        for key, value in (headers or {}).items():
            if key.lower() == "x-api-key":
                given = str(value or "")
                break
        if not expected or not given or not hmac.compare_digest(given.encode(), expected.encode()):
            raise WebhookRejected("The webhook token is missing or wrong.")
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ValueError("The webhook body is not JSON.") from None
        if not isinstance(payload, dict):
            raise ValueError("The webhook body is not a JSON object.")

        current = _text(payload.get("current_status"), 120) or _text(payload.get("shipment_status"), 120)
        scans_raw = payload.get("scans")
        scans = [e for e in (_scan(raw) for raw in (scans_raw if isinstance(scans_raw, list) else [])) if e]
        if not scans and current:
            occurred = parse_date(payload.get("current_timestamp"))
            event_id = ""
            if occurred is None:
                occurred = datetime.utcnow().replace(microsecond=0)
                event_id = hashlib.sha1(f"{payload.get('current_timestamp')}|{current}".encode()).hexdigest()
            scans = [TrackingEvent(status=map_status(current), provider_status=current, description=current,
                                   location="", occurred_at=occurred, provider_event_id=event_id)]
        scans.sort(key=lambda e: e.occurred_at)

        safe = {key: payload[key] for key in self.SAFE_FIELDS
                if key in payload and isinstance(payload[key], (str, int, float, bool))}
        safe = {k: (v[:200] if isinstance(v, str) else v) for k, v in safe.items()}
        if isinstance(scans_raw, list):
            safe["scans"] = [
                {k: (str(raw[k])[:200]) for k in self.SAFE_SCAN_FIELDS if k in raw and raw[k] is not None}
                for raw in scans_raw[:100] if isinstance(raw, dict)
            ]
        return WebhookEvent(
            event_key=hashlib.sha256(body).hexdigest(),
            awb=_ident(payload.get("awb")),
            provider_shipment_id=_ident(payload.get("shipment_id")),
            reference=_text(payload.get("order_id"), 64),
            status=map_status(current),
            provider_status=current,
            events=scans,
            expected_delivery_at=parse_date(payload.get("etd")),
            safe_payload=safe,
        )
