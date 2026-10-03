"""
The segment rule engine: the field registry, the validator and the compiler.

    rules (JSON from the builder) ──validate──► clean rules ──compile──► one SQL condition

The registry is the single source of truth for the builder (what it offers)
and for the evaluator (what each field means in SQL). A rule names a field and
an operator by key; both are looked up here, so an unknown one is a validation
error and never reaches SQL. Every value becomes a bound parameter.

The condition is over `customers` joined to `customer_metrics` (see
`base_query`); two list fields add an `EXISTS` over the order lines or a
`JSON_CONTAINS` on the purchased categories.
"""

from __future__ import annotations

from dataclasses import dataclass, field as dc_field
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Callable, Dict, List, Optional, Tuple

from sqlalchemy import and_, exists, false, func, not_, or_, select, true
from sqlalchemy.orm import Session

from app.core.errors import ValidationError
from app.models import Customer, Order, OrderItem
from app.models.segments import CustomerMetrics as M

MAX_CONDITIONS = 30
MAX_LIST_ITEMS = 100
MAX_TEXT = 120
MAX_DAYS = 3650
MAX_MONEY_RUPEES = 10_000_000
MAX_NUMBER = 1_000_000_000

GROUPS = [
    ("profile", "Profile"), ("shopping", "Shopping"), ("products", "Products"),
    ("marketing", "Marketing"), ("membership", "Membership"), ("loyalty", "Loyalty"),
]

# key -> (label, value shape the builder shows)
OPERATORS: Dict[str, Tuple[str, str]] = {
    "equals": ("is", "single"),
    "not-equals": ("is not", "single"),
    "gt": ("is more than", "single"),
    "lt": ("is less than", "single"),
    "gte": ("is at least", "single"),
    "lte": ("is at most", "single"),
    "between": ("is between", "range"),
    "contains": ("contains", "single"),
    "not-contains": ("does not contain", "single"),
    "starts-with": ("starts with", "single"),
    "ends-with": ("ends with", "single"),
    "in": ("is any of", "list"),
    "not-in": ("is none of", "list"),
    "before": ("is before", "single"),
    "after": ("is after", "single"),
    "within-last-days": ("is within the last (days)", "days"),
    "not-within-last-days": ("is not within the last (days)", "days"),
}

BY_TYPE: Dict[str, Tuple[str, ...]] = {
    "number": ("equals", "not-equals", "gt", "lt", "gte", "lte", "between"),
    "money": ("equals", "not-equals", "gt", "lt", "gte", "lte", "between"),
    "date": ("equals", "before", "after", "between", "within-last-days", "not-within-last-days"),
    "string": ("equals", "not-equals", "contains", "not-contains", "starts-with", "ends-with", "in", "not-in"),
    "enum": ("equals", "not-equals", "in", "not-in"),
    "list": ("contains", "not-contains", "in", "not-in"),
    "boolean": ("equals",),
}

RFM_LABELS = [
    ("champions", "Champions"), ("loyal", "Loyal"), ("potential", "Potential"), ("new", "New"),
    ("at-risk", "At risk"), ("hibernating", "Hibernating"), ("lost", "Lost"), ("no-orders", "No orders yet"),
]


@dataclass
class Field:
    key: str
    label: str
    group: str
    type: str
    # The SQL expression the condition compares. For list fields, see `list_sql`.
    column: Any = None
    description: str = ""
    unit: str = ""
    min: Optional[float] = None
    max: Optional[float] = None
    options: List[dict] = dc_field(default_factory=list)
    # Options read from the database each time the registry is served (categories, plans).
    dynamic_options: Optional[Callable[[Session], List[dict]]] = None
    # list fields: (values) -> SQL "the customer has any of these"
    list_sql: Optional[Callable[[List[str]], Any]] = None

    @property
    def operators(self) -> Tuple[str, ...]:
        return BY_TYPE[self.type]


def _purchased_products(values: List[str]):
    return exists().where(Order.customer_id == Customer.id, Order.status != "cancelled",
                          OrderItem.order_id == Order.id, OrderItem.product_id.in_(values))


def _purchased_categories(values: List[str]):
    return or_(*[func.coalesce(func.json_contains(M.purchased_category_ids, func.json_quote(v)), 0) == 1
                 for v in values])


def _categories(db: Session) -> List[dict]:
    from app.models import Category

    return [{"value": c.id, "label": c.name} for c in db.execute(select(Category).order_by(Category.name)).scalars()]


def _plans(db: Session) -> List[dict]:
    from app.models import MembershipPlan

    return [{"value": p.id, "label": p.name} for p in db.execute(select(MembershipPlan).order_by(MembershipPlan.name)).scalars()]


def _opts(*pairs) -> List[dict]:
    return [{"value": v, "label": l} for v, l in pairs]


def _count(key, label, group, column, description="", maximum=MAX_NUMBER) -> Field:
    return Field(key, label, group, "number", column, description, min=0, max=maximum)


def _money(key, label, group, column, description="") -> Field:
    return Field(key, label, group, "money", column, description, unit="₹", min=0, max=MAX_MONEY_RUPEES)


FIELDS: List[Field] = [
    # --- profile
    Field("joinedAt", "Registered", "profile", "date", Customer.joined_at),
    Field("lastLoginAt", "Last signed in", "profile", "date", Customer.last_login_at),
    Field("emailVerified", "Email verified", "profile", "boolean", Customer.email_verified_at.is_not(None)),
    Field("accountStatus", "Account status", "profile", "enum", Customer.status,
          options=_opts(("active", "Active"), ("blocked", "Blocked"))),
    Field("name", "Name", "profile", "string", func.concat(Customer.first_name, " ", Customer.last_name)),
    Field("email", "Email", "profile", "string", Customer.email),
    Field("city", "City", "profile", "string", M.city, "From the default address"),
    Field("state", "State", "profile", "string", M.state, "From the default address"),
    Field("pincode", "Pincode", "profile", "string", M.pincode, "From the default address"),
    # --- shopping
    _count("totalOrders", "Orders", "shopping", M.total_orders, "Orders not cancelled (returned ones count)"),
    _money("totalSpend", "Total spend", "shopping", M.total_spend,
           "Net of refunds; cancelled and returned orders excluded"),
    _money("averageOrderValue", "Average order value", "shopping", M.average_order_value),
    Field("firstOrderAt", "First order", "shopping", "date", M.first_order_at),
    Field("lastOrderAt", "Last order", "shopping", "date", M.last_order_at),
    _count("cancelledOrders", "Cancelled orders", "shopping", M.cancelled_orders),
    _count("returnedOrders", "Returned orders", "shopping", M.returned_orders),
    _count("refundedOrders", "Refunded orders", "shopping", M.refunded_orders, "Orders with a completed refund"),
    _count("returnRequests", "Return requests", "shopping", M.return_requests),
    _count("couponUses", "Coupon uses", "shopping", M.coupon_uses),
    Field("hasActiveCart", "Has items in the bag", "shopping", "boolean", M.has_active_cart),
    Field("hasAbandonedCart", "Has an abandoned bag", "shopping", "boolean", M.has_abandoned_cart),
    _count("abandonedCarts", "Abandoned bags", "shopping", M.abandoned_carts),
    Field("rfmLabel", "RFM group", "shopping", "enum", M.rfm_label, options=_opts(*RFM_LABELS)),
    _count("recencyScore", "Recency score (R)", "shopping", M.recency_score, "1–5; 0 without orders", 5),
    _count("frequencyScore", "Frequency score (F)", "shopping", M.frequency_score, "1–5; 0 without orders", 5),
    _count("monetaryScore", "Monetary score (M)", "shopping", M.monetary_score, "1–5; 0 without orders", 5),
    # --- products
    Field("purchasedCategories", "Bought from category", "products", "list", dynamic_options=_categories,
          list_sql=_purchased_categories),
    Field("purchasedProducts", "Bought product", "products", "list", description="Product ids",
          list_sql=_purchased_products),
    _count("productsViewed90d", "Products viewed (90 days)", "products", M.products_viewed_90d),
    _count("categoriesViewed90d", "Categories viewed (90 days)", "products", M.categories_viewed_90d),
    _count("wishlistItems", "Wishlist items", "products", M.wishlist_items),
    # --- marketing
    Field("emailOptIn", "Email marketing allowed", "marketing", "boolean", M.email_opt_in),
    Field("smsOptIn", "SMS marketing allowed", "marketing", "boolean", M.sms_opt_in),
    Field("whatsappOptIn", "WhatsApp marketing allowed", "marketing", "boolean", M.whatsapp_opt_in),
    _count("campaignsReceived", "Campaigns received", "marketing", M.campaigns_received),
    _count("campaignOpens", "Campaign opens", "marketing", M.campaign_opens),
    _count("campaignClicks", "Campaign clicks", "marketing", M.campaign_clicks),
    Field("lastEngagedAt", "Last opened or clicked", "marketing", "date", M.last_engaged_at),
    Field("wasReferred", "Joined through a referral", "marketing", "boolean", M.was_referred),
    _count("referralCount", "Successful referrals", "marketing", M.referral_count),
    # --- membership
    Field("membershipStatus", "Membership", "membership", "enum", M.membership_status,
          options=_opts(("active", "Active"), ("expired", "Expired"), ("cancelled", "Cancelled"), ("none", "Never a member"))),
    Field("membershipPlan", "Membership plan", "membership", "enum", M.membership_plan_id, dynamic_options=_plans),
    # --- loyalty
    _count("pointsBalance", "Reward points", "loyalty", M.points_balance),
    _money("storeCreditBalance", "Store credit", "loyalty", M.store_credit_balance),
    _count("giftCardOrders", "Orders paid with a gift card", "loyalty", M.gift_card_orders),
    _money("giftCardSpend", "Paid with gift cards", "loyalty", M.gift_card_spend),
]
REGISTRY: Dict[str, Field] = {f.key: f for f in FIELDS}


def registry(db: Session) -> dict:
    """The builder's view of the registry."""
    fields = []
    for f in FIELDS:
        options = f.dynamic_options(db) if f.dynamic_options else f.options
        fields.append({"key": f.key, "label": f.label, "group": f.group, "type": f.type,
                       "operators": list(f.operators), "options": options, "unit": f.unit,
                       "description": f.description, "min": f.min, "max": f.max})
    return {
        "groups": [{"key": k, "label": l} for k, l in GROUPS],
        "fields": fields,
        "operators": [{"key": k, "label": l, "value": v} for k, (l, v) in OPERATORS.items()],
        "limits": {"maxConditions": MAX_CONDITIONS, "maxListItems": MAX_LIST_ITEMS},
    }


# --------------------------------------------------------------- validation


class _Problem(Exception):
    pass


def _fail(message: str, path: str, rule: Optional[dict] = None) -> None:
    rule = rule if isinstance(rule, dict) else {}
    raise ValidationError(message, error_code="INVALID_SEGMENT_RULE",
                          details={"path": path, "field": rule.get("field"), "operator": rule.get("operator")})


def _whole(value, f: Field) -> int:
    if isinstance(value, bool) or value is None or value == "":
        raise _Problem("needs a number")
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        raise _Problem("needs a number") from None
    if number != number.to_integral_value():
        raise _Problem("needs a whole number")
    number = int(number)
    if f.min is not None and number < f.min or f.max is not None and number > f.max:
        raise _Problem(f"must be between {int(f.min or 0):,} and {int(f.max):,}")
    return number


def _paise(value, f: Field) -> int:
    if isinstance(value, bool) or value is None or value == "":
        raise _Problem("needs an amount in rupees")
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        raise _Problem("needs an amount in rupees") from None
    if not amount.is_finite():
        raise _Problem("needs an amount in rupees")
    if amount < 0 or amount > MAX_MONEY_RUPEES:
        raise _Problem(f"must be between ₹0 and ₹{MAX_MONEY_RUPEES:,}")
    if amount != amount.quantize(Decimal("0.01")):
        raise _Problem("can have at most two decimals")
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _day(value) -> date:
    if not isinstance(value, str) or len(value) != 10:
        raise _Problem("needs a date (YYYY-MM-DD)")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise _Problem(f"“{value[:10]}” isn't a real date") from None


def _days(value) -> int:
    if isinstance(value, bool):
        raise _Problem("needs a number of days")
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        raise _Problem("needs a number of days") from None
    if number != number.to_integral_value() or not 1 <= number <= MAX_DAYS:
        raise _Problem(f"needs a whole number of days from 1 to {MAX_DAYS:,}")
    return int(number)


def _text(value) -> str:
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        raise _Problem("needs some text")
    text = str(value).strip()
    if not text:
        raise _Problem("needs some text")
    if len(text) > MAX_TEXT:
        raise _Problem(f"must be at most {MAX_TEXT} characters")
    return text


def _values(value, one) -> list:
    if not isinstance(value, list) or not value:
        raise _Problem("needs at least one value")
    if len(value) > MAX_LIST_ITEMS:
        raise _Problem(f"can list at most {MAX_LIST_ITEMS} values")
    return list(dict.fromkeys(one(v) for v in value))


def _option(value, allowed: set) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise _Problem("needs one of the listed choices")
    return value


def _clean_value(f: Field, operator: str, value, allowed: Optional[set]):
    """The value in the form the compiler uses (paise, dates, lists...)."""
    if f.type in ("number", "money"):
        one = (lambda v: _whole(v, f)) if f.type == "number" else (lambda v: _paise(v, f))
        if operator == "between":
            if not isinstance(value, list) or len(value) != 2:
                raise _Problem("needs two values, the lower first" if f.type == "number" else "needs two amounts, the lower first")
            low, high = one(value[0]), one(value[1])
            if low > high:
                raise _Problem("needs the lower value first")
            return [low, high]
        return one(value)
    if f.type == "date":
        if operator in ("within-last-days", "not-within-last-days"):
            return _days(value)
        if operator == "between":
            if not isinstance(value, list) or len(value) != 2:
                raise _Problem("needs two dates, the earlier first")
            start, end = _day(value[0]), _day(value[1])
            if start > end:
                raise _Problem("needs the earlier date first")
            return [start, end]
        return _day(value)
    if f.type == "string":
        return _values(value, _text) if operator in ("in", "not-in") else _text(value)
    if f.type == "enum":
        if allowed is not None:
            check = lambda v: _option(v, allowed)  # noqa: E731
        else:
            check = _text
        return _values(value, check) if operator in ("in", "not-in") else check(value)
    if f.type == "list":
        check = (lambda v: _option(v, allowed)) if allowed is not None else (lambda v: _text(v)[:20])
        return _values(value, check) if operator in ("in", "not-in") else check(value)
    if f.type == "boolean":
        if not isinstance(value, bool):
            raise _Problem("needs yes or no")
        return value
    raise _Problem("isn't supported")  # pragma: no cover - every type is handled above


def _clean_condition(rule: dict, path: str, options: Dict[str, set]) -> dict:
    key = rule.get("field")
    f = REGISTRY.get(key) if isinstance(key, str) else None
    if f is None:
        _fail(f"Choose a field to filter on{f' (“{str(key)[:40]}” is not one)' if key else ''}.", path, rule)
    operator = rule.get("operator")
    if not isinstance(operator, str) or operator not in OPERATORS:
        _fail(f"{f.label}: choose a condition.", path, rule)
    if operator not in f.operators:
        _fail(f"{f.label}: “{OPERATORS[operator][0]}” can't be used with this field.", path, rule)
    try:
        value = _clean_value(f, operator, rule.get("value"), options.get(f.key))
    except _Problem as problem:
        _fail(f"{f.label}: “{OPERATORS[operator][0]}” {problem}.", path, rule)
    stored = value
    if f.type == "money":  # stored as the admin typed it (rupees); compiled in paise
        stored = rule.get("value")
        stored = [float(Decimal(str(v))) for v in stored] if isinstance(stored, list) else float(Decimal(str(stored)))
    elif f.type == "date" and operator not in ("within-last-days", "not-within-last-days"):
        stored = [d.isoformat() for d in value] if isinstance(value, list) else value.isoformat()
    return {"field": f.key, "operator": operator, "value": stored}


def _option_sets(db: Optional[Session]) -> Dict[str, set]:
    sets = {f.key: {o["value"] for o in f.options} for f in FIELDS if f.options}
    if db is not None:
        for f in FIELDS:
            if f.dynamic_options and f.type == "enum":
                sets[f.key] = {o["value"] for o in f.dynamic_options(db)}
    return sets


def clean(match: Any, rules: Any, db: Optional[Session] = None) -> Tuple[str, List[dict]]:
    """Validated `(match, rules)`, ready to store. Raises INVALID_SEGMENT_RULE with the path."""
    if match not in ("all", "any"):
        _fail("Choose whether customers must match all the conditions or any of them.", "match")
    if rules is None:
        rules = []
    if not isinstance(rules, list):
        _fail("The conditions must be a list.", "rules")
    options = _option_sets(db)
    out: List[dict] = []
    total = 0
    for i, rule in enumerate(rules):
        path = f"rules.{i}"
        if not isinstance(rule, dict):
            _fail("Each condition must be an object.", path)
        if "rules" in rule:
            if rule.get("match") not in ("all", "any"):
                _fail("Choose all or any for this group.", path, rule)
            inner = rule.get("rules")
            if not isinstance(inner, list) or not inner:
                _fail("A group needs at least one condition.", path, rule)
            group = []
            for j, child in enumerate(inner):
                if not isinstance(child, dict):
                    _fail("Each condition must be an object.", f"{path}.rules.{j}")
                if "rules" in child:
                    _fail("Groups can't contain groups.", f"{path}.rules.{j}", child)
                group.append(_clean_condition(child, f"{path}.rules.{j}", options))
            total += len(group)
            out.append({"match": rule["match"], "rules": group})
        else:
            out.append(_clean_condition(rule, path, options))
            total += 1
        if total > MAX_CONDITIONS:
            _fail(f"A segment can have at most {MAX_CONDITIONS} conditions.", path)
    return match, out


def count_conditions(rules: List[dict]) -> int:
    return sum(len(r["rules"]) if "rules" in r else 1 for r in rules or [])


# ---------------------------------------------------------------- compiling


def _start(day: date) -> datetime:
    return datetime.combine(day, datetime.min.time())


def _condition(rule: dict, now: datetime):
    f = REGISTRY[rule["field"]]
    operator, value = rule["operator"], rule["value"]
    if f.type == "list":
        if operator in ("contains", "not-contains"):
            hit = f.list_sql([value])
            return hit if operator == "contains" else not_(hit)
        hit = f.list_sql(list(value))
        return hit if operator == "in" else not_(hit)
    col = f.column
    if f.type == "money":
        value = [_paise(v, f) for v in value] if isinstance(value, list) else _paise(value, f)
    if f.type in ("number", "money"):
        return {
            "equals": lambda: col == value, "not-equals": lambda: col != value,
            "gt": lambda: col > value, "lt": lambda: col < value,
            "gte": lambda: col >= value, "lte": lambda: col <= value,
            "between": lambda: and_(col >= value[0], col <= value[1]),
        }[operator]()
    if f.type == "date":
        if operator == "within-last-days":
            return col >= now - timedelta(days=int(value))
        if operator == "not-within-last-days":
            return or_(col.is_(None), col < now - timedelta(days=int(value)))
        if operator == "between":
            start, end = (date.fromisoformat(v) for v in value)
            return and_(col >= _start(start), col < _start(end) + timedelta(days=1))
        day = date.fromisoformat(value)
        if operator == "before":
            return col < _start(day)
        if operator == "after":
            return col >= _start(day) + timedelta(days=1)
        return and_(col >= _start(day), col < _start(day) + timedelta(days=1))  # equals
    if f.type == "boolean":
        if f.key == "emailVerified":  # an expression (verified_at IS NOT NULL), not a column
            return col if value else not_(col)
        return col.is_(true()) if value else col.is_(false())
    if f.type == "string":
        if operator == "contains":
            return col.contains(value, autoescape=True)
        if operator == "not-contains":
            return not_(col.contains(value, autoescape=True))
        if operator == "starts-with":
            return col.startswith(value, autoescape=True)
        if operator == "ends-with":
            return col.endswith(value, autoescape=True)
    if operator == "equals":
        return col == value
    if operator == "not-equals":
        return or_(col != value, col.is_(None))
    if operator == "in":
        return col.in_(value)
    return or_(col.not_in(value), col.is_(None))  # not-in


def compile_rules(match: str, rules: List[dict], now: Optional[datetime] = None):
    """One SQL condition for already-cleaned rules (over customers ⋈ customer_metrics)."""
    now = now or datetime.utcnow()
    parts = []
    for rule in rules or []:
        if "rules" in rule:
            inner = [_condition(child, now) for child in rule["rules"]]
            parts.append(and_(*inner) if rule["match"] == "all" else or_(*inner))
        else:
            parts.append(_condition(rule, now))
    if not parts:
        return true()
    return and_(*parts) if match == "all" else or_(*parts)


def base_query(*columns):
    """`SELECT <columns> FROM customers JOIN customer_metrics`."""
    return select(*(columns or (Customer.id,))).select_from(Customer).join(M, M.customer_id == Customer.id)


def matching_ids(match: str, rules: List[dict], now: Optional[datetime] = None):
    """A SELECT of the ids of every customer the rules describe."""
    return base_query(Customer.id).where(compile_rules(match, rules, now))
