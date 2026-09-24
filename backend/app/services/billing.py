"""Billing arithmetic — the authority for every total.

**This is the only place order money is worked out.** The cart, the checkout,
the order, the invoice and the reports all render what this produces. The
frontend may show a figure while a request is in flight, but the number that
counts comes from here: a client that computes its own total is a client that
can be persuaded to compute a smaller one.

Amounts are integers in the currency's minor unit — paise, never rupees, never
a float. `0.1 + 0.2` is not `0.3` in binary floating point, and a hundredth of
a rupee lost per line becomes an invoice that does not add up.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Dict, Iterable, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import SettingDocument

Money = int


# ---------------------------------------------------------------- config


def _document(db: Session, key: str, fallback: dict) -> dict:
    row = db.get(SettingDocument, key)
    return row.value if row and row.value else fallback


def billing_config(db: Session) -> dict:
    return _document(db, "billing", {})


def tax_config(db: Session) -> dict:
    return _document(
        db,
        "tax",
        {
            "enabled": True,
            "taxType": "GST",
            "pricesIncludeTax": True,
            "originState": "Karnataka",
            "rates": {"cgst": 2.5, "sgst": 2.5, "igst": 5},
            "categoryRates": {},
        },
    )


def store_settings(db: Session) -> dict:
    return _document(db, "store", {})


# ------------------------------------------------------------- money bits


def to_minor(major: float | Decimal, decimals: int = 2) -> Money:
    """Rupees to paise, exactly. Decimal, not float — see the module docstring."""
    return int((Decimal(str(major)) * (10**decimals)).to_integral_value(rounding=ROUND_HALF_UP))


def to_major(minor: Money, decimals: int = 2) -> float:
    return minor / (10**decimals)


def percent_of(amount: Money, percent: float) -> Money:
    """Half-up, because that is what an Indian invoice and the accountant
    checking it both expect."""
    return int(
        (Decimal(amount) * Decimal(str(percent)) / Decimal(100)).to_integral_value(
            rounding=ROUND_HALF_UP
        )
    )


def allocate(amount: Money, weights: Sequence[int]) -> List[Money]:
    """
    Split an amount across weights so the parts sum **exactly** back to it.

    Rounding each share independently loses or gains a paisa, and an invoice
    whose lines do not add up to its total is one nobody trusts. The
    largest-remainder method hands the leftover units to the shares rounded
    down hardest.

    This is what apportions an order-level coupon across the lines it
    discounted, which is what makes the per-line taxes reconcile.
    """
    total = sum(weights)
    if total <= 0 or not weights:
        return [0] * len(weights)

    exact = [Decimal(amount) * Decimal(w) / Decimal(total) for w in weights]
    floors = [int(value) for value in exact]
    remainder = amount - sum(floors)

    order = sorted(range(len(exact)), key=lambda i: exact[i] - floors[i], reverse=True)
    result = list(floors)
    for index in order:
        if remainder <= 0:
            break
        result[index] += 1
        remainder -= 1

    return result


def tax_included_in(gross: Money, rate_percent: float) -> tuple[Money, Money]:
    """
    Pull the tax out of a tax-inclusive amount.

    `net = gross ÷ (1 + rate)`, and the tax is the remainder — derived rather
    than computed directly, which guarantees `net + tax == gross` with no stray
    paisa.
    """
    if rate_percent <= 0:
        return gross, 0

    net = int(
        (Decimal(gross) * Decimal(100) / (Decimal(100) + Decimal(str(rate_percent))))
        .to_integral_value(rounding=ROUND_HALF_UP)
    )
    return net, gross - net


# ------------------------------------------------------------------- tax


def _normalise(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def tax_mode_for(place_of_supply: str, config: dict) -> str:
    """
    Which tax applies.

    Supply inside the seller's registered state is split between the centre and
    the state; supply across a state line is a single integrated tax. That is
    the only rule modelled here.
    """
    if not config.get("enabled") or config.get("taxType") == "NONE":
        return "none"
    return (
        "intra-state"
        if _normalise(place_of_supply) == _normalise(config.get("originState", ""))
        else "inter-state"
    )


def rates_for(category: Optional[str], config: dict) -> dict:
    overrides = config.get("categoryRates") or {}
    if category and category in overrides:
        return overrides[category]
    return config.get("rates", {"cgst": 0, "sgst": 0, "igst": 0})


def calculate_tax(
    amount: Money, place_of_supply: str, category: Optional[str], config: dict
) -> dict:
    """
    Tax on an amount.

    **A configurable representation of GST, not a compliance calculation.** Real
    treatment depends on HSN classification, exemptions, reverse charge and
    place-of-supply rules that need an accountant behind them. What this gives
    is the right shape, computed once, in one place.

    CGST and SGST are derived by halving the *total*, not the rate, so the two
    halves always sum to the whole.
    """
    mode = tax_mode_for(place_of_supply, config)

    if mode == "none" or amount <= 0:
        return {
            "mode": "none",
            "taxableAmount": max(0, amount),
            "cgst": 0,
            "sgst": 0,
            "igst": 0,
            "totalTax": 0,
            "ratePercent": 0,
        }

    rates = rates_for(category, config)
    rate = rates["cgst"] + rates["sgst"] if mode == "intra-state" else rates["igst"]

    if config.get("pricesIncludeTax", True):
        taxable, total_tax = tax_included_in(amount, rate)
    else:
        taxable, total_tax = amount, percent_of(amount, rate)

    if mode == "inter-state":
        return {
            "mode": mode,
            "taxableAmount": taxable,
            "cgst": 0,
            "sgst": 0,
            "igst": total_tax,
            "totalTax": total_tax,
            "ratePercent": rate,
        }

    cgst = int((Decimal(total_tax) / 2).to_integral_value(rounding=ROUND_HALF_UP))
    return {
        "mode": mode,
        "taxableAmount": taxable,
        "cgst": cgst,
        "sgst": total_tax - cgst,
        "igst": 0,
        "totalTax": total_tax,
        "ratePercent": rate,
    }


# -------------------------------------------------------------- the total


HSN_BY_CATEGORY: Dict[str, str] = {
    "women": "6204", "men": "6203", "kids": "6209", "footwear": "6403",
    "bags": "4202", "jewellery": "7117", "accessories": "6217",
    "beauty": "3304", "home": "6304", "electronics": "8517", "lifestyle": "9503",
}


class BillingLine:
    """One line going into the calculation."""

    def __init__(
        self,
        *,
        product_id: str,
        name: str,
        sku: str,
        category: Optional[str],
        size: Optional[str],
        color: Optional[str],
        quantity: int,
        unit_price: Money,
        list_price: Money,
    ) -> None:
        self.product_id = product_id
        self.name = name
        self.sku = sku
        self.category = category
        self.size = size
        self.color = color
        self.quantity = quantity
        self.unit_price = unit_price
        self.list_price = list_price


def calculate(
    db: Session,
    lines: Iterable[BillingLine],
    *,
    place_of_supply: str,
    shipping: Money = 0,
    other_charges: Money = 0,
    coupon: Optional[dict] = None,
) -> dict:
    """
    The one calculation: a breakdown, and the invoice lines that make it up.

    Tax is worked out per line rather than once on the total, because rates
    vary by category and an invoice has to show the tax against each item. The
    order-level coupon is apportioned across lines first — see `allocate` — so
    the line taxes reconcile with the invoice total exactly.
    """
    tax_cfg = tax_config(db)
    billing_cfg = billing_config(db)
    currency = (billing_cfg.get("currency") or {}).get("code", "INR")
    prices_include_tax = bool(tax_cfg.get("pricesIncludeTax", True))
    mode = tax_mode_for(place_of_supply, tax_cfg)

    lines = list(lines)
    item_count = sum(line.quantity for line in lines)
    subtotal = sum(line.unit_price * line.quantity for line in lines)
    product_discount = sum(
        max(0, line.list_price - line.unit_price) * line.quantity for line in lines
    )

    coupon_discount = calculate_coupon_discount(subtotal, coupon)

    line_values = [line.unit_price * line.quantity for line in lines]
    line_discounts = allocate(coupon_discount, line_values)

    invoice_lines: List[dict] = []
    tax_totals = {"taxableAmount": 0, "cgst": 0, "sgst": 0, "igst": 0, "totalTax": 0, "ratePercent": 0}

    for line, discount in zip(lines, line_discounts):
        line_subtotal = line.unit_price * line.quantity
        chargeable = max(0, line_subtotal - discount)
        line_tax = calculate_tax(chargeable, place_of_supply, line.category, tax_cfg)

        for key in ("taxableAmount", "cgst", "sgst", "igst", "totalTax"):
            tax_totals[key] += line_tax[key]
        tax_totals["ratePercent"] = max(tax_totals["ratePercent"], line_tax["ratePercent"])

        invoice_lines.append(
            {
                "productId": line.product_id,
                "name": line.name,
                "sku": line.sku,
                "hsn": HSN_BY_CATEGORY.get(line.category or "", "9999"),
                "size": line.size,
                "color": line.color,
                "quantity": line.quantity,
                "unitPrice": line.unit_price,
                "lineSubtotal": line_subtotal,
                "discount": discount,
                "taxableAmount": line_tax["taxableAmount"],
                "taxRatePercent": line_tax["ratePercent"],
                "cgst": line_tax["cgst"],
                "sgst": line_tax["sgst"],
                "igst": line_tax["igst"],
                "tax": line_tax["totalTax"],
                "lineTotal": chargeable if prices_include_tax else chargeable + line_tax["totalTax"],
            }
        )

    goods = max(0, subtotal - coupon_discount)
    # When prices include tax it is already inside `goods`; adding it again
    # would charge it twice.
    grand_total = goods + shipping + other_charges + (0 if prices_include_tax else tax_totals["totalTax"])

    breakdown = {
        "currency": currency,
        "itemCount": item_count,
        "subtotal": subtotal,
        "productDiscount": product_discount,
        "couponDiscount": coupon_discount,
        "couponCode": (coupon or {}).get("code"),
        "shipping": shipping,
        "otherCharges": other_charges,
        "taxableAmount": tax_totals["taxableAmount"],
        "tax": {
            "mode": mode,
            "taxableAmount": tax_totals["taxableAmount"],
            "cgst": tax_totals["cgst"],
            "sgst": tax_totals["sgst"],
            "igst": tax_totals["igst"],
            "totalTax": tax_totals["totalTax"],
            "ratePercent": tax_totals["ratePercent"],
        },
        "grandTotal": max(0, grand_total),
        "pricesIncludeTax": prices_include_tax,
    }

    return {"breakdown": breakdown, "lines": invoice_lines}


def calculate_coupon_discount(subtotal: Money, coupon: Optional[dict]) -> Money:
    """What a coupon is worth against a subtotal. Never more than the subtotal."""
    if not coupon:
        return 0

    if subtotal < to_minor(coupon.get("minSubtotal", 0)):
        return 0

    kind = coupon.get("type", "percent")

    if kind == "percent":
        raw = percent_of(subtotal, float(coupon.get("value", 0)))
        cap = coupon.get("maxDiscount")
        if cap is not None:
            raw = min(raw, to_minor(cap))
        return max(0, min(raw, subtotal))

    if kind == "flat":
        return max(0, min(to_minor(coupon.get("value", 0)), subtotal))

    # free-shipping waives delivery rather than reducing the goods value.
    return 0


def calculate_shipping(
    db: Session,
    *,
    subtotal: Money,
    item_count: int,
    method: str = "standard",
    coupon_waives_shipping: bool = False,
) -> Money:
    """
    Delivery.

    Two rules that are easy to get subtly wrong: the free-delivery threshold is
    tested against the *pre-coupon* subtotal, so applying a coupon never
    quietly adds a fee back; and it waives the *standard* fee only, because an
    express upgrade is a paid service whatever the basket is worth.
    """
    if item_count == 0:
        return 0

    shipping = (store_settings(db).get("shipping") or {})
    threshold = to_minor(shipping.get("freeDeliveryThreshold", 999))
    standard = to_minor(shipping.get("standardFee", 79))
    express = to_minor(shipping.get("expressFee", 149))

    if method == "express":
        return express

    if coupon_waives_shipping or subtotal >= threshold:
        return 0

    return standard
