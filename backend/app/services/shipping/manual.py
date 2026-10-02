"""
The Manual provider: couriers without an API.

The team books the parcel with the courier themselves, types the courier's
name and the AWB here, and records each tracking update by hand. Nothing
leaves this process: no network, no credentials.
"""

from __future__ import annotations

from app.services.shipping.base import CreateRequest, CreateResult, ProviderError, ShippingProvider


class ManualProvider(ShippingProvider):
    code = "manual"
    name = "Manual"
    description = "For couriers without an API: enter the courier and AWB yourself and record tracking updates by hand."
    environments = ("production",)
    credential_fields = ()
    required_credentials = ()
    manual_awb = True

    def test_connection(self) -> str:
        return "Manual shipping needs no connection."

    def create_shipment(self, request: CreateRequest) -> CreateResult:
        awb = (request.awb or "").strip()
        courier = (request.courier_name or "").strip()
        if not awb or not courier:
            raise ProviderError("Enter the courier's name and the AWB number.", transient=False,
                                code="AWB_REQUIRED")
        return CreateResult(awb=awb, courier_name=courier, courier_code=request.courier_code or "")

    def cancel_shipment(self, *, provider_order_id: str, provider_shipment_id: str, awb: str) -> None:
        # Local only: the team tells the courier themselves.
        return None
