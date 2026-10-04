"""
Saved segments: create, edit, archive, recalculate, members, export, history,
the default segments, and the dashboard summary. See
docs/customer-segmentation.md, §4 and §6.
"""

from __future__ import annotations

import csv
import io
import logging
import re
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import delete, exists, func, insert, literal, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import AdminUser, Customer
from app.models.segments import CustomerMetrics, Segment, SegmentEvent, SegmentMember
from app.services.lookup.filters import id_condition
from app.services.segments import metrics, rules as engine

logger = logging.getLogger(__name__)

PREVIEW_PAGE_MAX = 25
HISTORY_LIMIT = 50
EXPORT_CHUNK = 1000

ACTION_LABELS = {
    "created": "Created", "updated": "Details changed", "rules-changed": "Rules changed",
    "recalculated": "Recalculated", "archived": "Archived", "restored": "Restored", "exported": "Exported",
}


def _c(field, op, value):
    return {"field": field, "operator": op, "value": value}


# Ordinary rows once seeded: editable and archivable. Inserted only when their slug is missing.
DEFAULTS = [
    ("new-customers", "New Customers", "Registered in the last 30 days.", "all",
     [_c("joinedAt", "within-last-days", 30)]),
    ("returning-customers", "Returning Customers", "More than one order, the latest in the last 6 months.", "all",
     [_c("totalOrders", "gte", 2), _c("lastOrderAt", "within-last-days", 180)]),
    ("vip", "VIP", "Big spenders who keep coming back.", "all",
     [_c("totalSpend", "gte", 25000), _c("totalOrders", "gte", 5), _c("lastOrderAt", "within-last-days", 180)]),
    ("high-value", "High Value", "Spent ₹10,000 or more.", "all", [_c("totalSpend", "gte", 10000)]),
    ("frequent-buyers", "Frequent Buyers", "Five or more orders.", "all", [_c("totalOrders", "gte", 5)]),
    ("inactive", "Inactive", "Have ordered, but not in the last 6 months.", "all",
     [_c("totalOrders", "gte", 1), _c("lastOrderAt", "not-within-last-days", 180)]),
    ("at-risk", "At-Risk", "Used to buy often, haven't lately (RFM).", "all", [_c("rfmLabel", "in", ["at-risk"])]),
    ("coupon-users", "Coupon Users", "Have used a coupon.", "all", [_c("couponUses", "gte", 1)]),
    ("non-coupon-customers", "Non-Coupon Customers", "Have ordered, never with a coupon.", "all",
     [_c("totalOrders", "gte", 1), _c("couponUses", "equals", 0)]),
    ("recent-buyers", "Recent Buyers", "Ordered in the last 30 days.", "all",
     [_c("lastOrderAt", "within-last-days", 30)]),
    ("one-time-buyers", "One-Time Buyers", "Exactly one order.", "all", [_c("totalOrders", "equals", 1)]),
    ("repeat-buyers", "Repeat Buyers", "Two or more orders.", "all", [_c("totalOrders", "gte", 2)]),
    ("cart-abandoners", "Cart Abandoners", "Have a bag they left behind.", "all",
     [_c("hasAbandonedCart", "equals", True)]),
    ("wishlist-users", "Wishlist Users", "Have saved something to their wishlist.", "all",
     [_c("wishlistItems", "gte", 1)]),
    ("membership-customers", "Membership Customers", "Have an active membership.", "all",
     [_c("membershipStatus", "equals", "active")]),
]


# ------------------------------------------------------------------ helpers


def _actor(admin: Optional[AdminUser]) -> tuple:
    return (admin.id, (admin.name or "")[:120]) if admin is not None else ("system", "")


def _event(db: Session, segment: Segment, action: str, admin: Optional[AdminUser], details: Optional[dict] = None):
    actor, name = _actor(admin)
    db.add(SegmentEvent(segment_id=segment.id, action=action, actor=actor, actor_name=name, details=details,
                        occurred_at=datetime.utcnow()))


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:120]
    return slug or "segment"


def _unique_slug(db: Session, name: str) -> str:
    base = _slugify(name)
    slug, n = base, 2
    while db.execute(select(Segment.id).where(Segment.slug == slug)).first():
        slug, n = f"{base}-{n}", n + 1
    return slug


def load(db: Session, segment_id, *, lock: bool = False) -> Segment:
    try:
        key = int(segment_id)
    except (TypeError, ValueError):
        key = None
    query = select(Segment).where(Segment.id == key)
    row = db.execute(query.with_for_update() if lock else query).scalar_one_or_none() if key is not None else None
    if row is None:
        raise NotFoundError("No such segment.", error_code="SEGMENT_NOT_FOUND")
    return row


def can_export(admin: AdminUser) -> bool:
    from app.core.permissions import permissions_for

    return admin.role == "super-admin" or "segments-export" in (admin.permissions or []) \
        or "segments-export" in permissions_for(admin.role)


def mask_email(value: str) -> str:
    if not value or "@" not in value:
        return "•••" if value else ""
    local, _, domain = value.partition("@")
    return f"{local[:1]}••••@{domain}"


def mask_phone(value: str) -> str:
    digits = value or ""
    if len(digits) <= 5:
        return "•" * len(digits)
    return digits[:3] + "•" * max(3, len(digits) - 8) + digits[-5:]


# ------------------------------------------------------------------ defaults


def ensure_defaults(db: Session) -> int:
    """Insert each default segment whose slug is missing. Idempotent; never touches an existing row."""
    existing = set(db.execute(select(Segment.slug).where(Segment.slug.in_([d[0] for d in DEFAULTS]))).scalars())
    added = 0
    now = datetime.utcnow().replace(microsecond=0)
    for slug, name, description, match, rule_list in DEFAULTS:
        if slug in existing:
            continue
        try:
            with db.begin_nested():
                row = Segment(name=name, slug=slug, description=description, match=match, rules=rule_list,
                              kind="default", status="active", member_count=0, created_by="system",
                              updated_by="system", created_at=now, updated_at=now)
                db.add(row)
                db.flush()
                _event(db, row, "created", None, {"default": True})
            added += 1
        except IntegrityError:  # seeded by someone else at the same moment
            continue
    if added:
        db.commit()
    return added


# -------------------------------------------------------------- recalculate


def recalculate(db: Session, segment: Segment, *, admin: Optional[AdminUser] = None,
                customer_ids: Optional[List[str]] = None, record: Optional[bool] = None) -> dict:
    """
    Bring the materialised membership up to date, as a diff in SQL: remove who
    no longer matches, add who now does. `customer_ids` limits it to those
    customers (after a dirty refresh). Commits.
    """
    db.execute(select(Segment.id).where(Segment.id == segment.id).with_for_update())
    before = segment.member_count or 0
    matching = engine.matching_ids(segment.match, segment.rules)
    scope = []
    if customer_ids is not None:
        if not customer_ids:
            return {"before": before, "after": before}
        scope = [Customer.id.in_(customer_ids)]
        matching = matching.where(*scope)
    removed = delete(SegmentMember).where(SegmentMember.segment_id == segment.id,
                                          SegmentMember.customer_id.not_in(matching))
    if customer_ids is not None:
        removed = removed.where(SegmentMember.customer_id.in_(customer_ids))
    db.execute(removed)
    now = datetime.utcnow().replace(microsecond=0)
    already = exists().where(SegmentMember.segment_id == segment.id, SegmentMember.customer_id == Customer.id)
    adds = (engine.base_query(literal(segment.id), Customer.id, literal(now))
            .where(engine.compile_rules(segment.match, segment.rules), ~already, *scope))
    db.execute(insert(SegmentMember).from_select(["segment_id", "customer_id", "added_at"], adds))
    after = db.execute(select(func.count()).select_from(SegmentMember)
                       .where(SegmentMember.segment_id == segment.id)).scalar_one()
    segment.member_count, segment.last_calculated_at = int(after), now
    if record if record is not None else (admin is not None or after != before):
        _event(db, segment, "recalculated", admin, {"before": before, "after": int(after),
                                                    "scope": "customers" if customer_ids is not None else "all"})
    db.commit()
    return {"before": before, "after": int(after)}


def recalculate_active(db: Session, customer_ids: Optional[List[str]] = None) -> int:
    ids = list(db.execute(select(Segment.id).where(Segment.status == "active").order_by(Segment.id)).scalars())
    for segment_id in ids:
        segment = db.get(Segment, segment_id)
        try:
            recalculate(db, segment, customer_ids=customer_ids)
        except Exception:  # noqa: BLE001 - one bad segment must not stop the others
            db.rollback()
            logger.exception("Recalculating segment %s failed", segment_id)
    return len(ids)


# ---------------------------------------------------------------------- CRUD


def _clean_details(db: Session, payload: dict, segment: Optional[Segment]) -> dict:
    if not isinstance(payload, dict):
        raise ValidationError("Send the segment as an object.", error_code="INVALID_SEGMENT")
    out = {}
    if segment is None or "name" in payload:
        name = payload.get("name")
        name = name.strip() if isinstance(name, str) else ""
        if not 2 <= len(name) <= 120:
            raise ValidationError("Give the segment a name (2 to 120 characters).", error_code="INVALID_SEGMENT")
        clash = db.execute(select(Segment.id).where(func.lower(Segment.name) == name.lower(),
                                                   Segment.id != (segment.id if segment else -1))).first()
        if clash:
            raise ConflictError(f"There's already a segment called “{name}”.", error_code="SEGMENT_NAME_TAKEN")
        out["name"] = name
    if "description" in payload:
        description = payload.get("description")
        if description is not None and not isinstance(description, str):
            raise ValidationError("The description must be text.", error_code="INVALID_SEGMENT")
        out["description"] = (description or "").strip()[:500]
    if segment is None or "rules" in payload or "match" in payload:
        match = payload.get("match", segment.match if segment else "all")
        rule_list = payload.get("rules", segment.rules if segment else [])
        out["match"], out["rules"] = engine.clean(match, rule_list, db)
    return out


def create(db: Session, admin: AdminUser, payload: dict) -> Segment:
    from app.services import audit

    clean = _clean_details(db, payload, None)
    now = datetime.utcnow().replace(microsecond=0)
    row = Segment(name=clean["name"], slug=_unique_slug(db, clean["name"]), description=clean.get("description", ""),
                  match=clean["match"], rules=clean["rules"], kind="custom", status="active", member_count=0,
                  created_by=admin.id, updated_by=admin.id, created_at=now, updated_at=now)
    db.add(row)
    db.flush()
    _event(db, row, "created", admin, {"match": row.match, "rules": row.rules})
    audit.record(db, "segment.create", resource_type="segments", resource_id=row.id, actor=admin,
                 summary=f"Created segment {row.name}")
    db.commit()
    recalculate(db, row, admin=admin, record=False)
    return row


def update(db: Session, admin: AdminUser, segment_id, payload: dict) -> Segment:
    from app.services import audit

    row = load(db, segment_id, lock=True)
    if row.status == "archived":
        raise ConflictError("Restore this segment before changing it.", error_code="SEGMENT_ARCHIVED")
    clean = _clean_details(db, payload, row)
    before = {"name": row.name, "description": row.description}
    rules_before = {"match": row.match, "rules": row.rules}
    for key, value in clean.items():
        setattr(row, key, value)
    rules_changed = {"match": row.match, "rules": row.rules} != rules_before
    details_changed = {"name": row.name, "description": row.description} != before
    row.updated_by, row.updated_at = admin.id, datetime.utcnow().replace(microsecond=0)
    if details_changed:
        _event(db, row, "updated", admin, {"before": before, "after": {"name": row.name, "description": row.description}})
    if rules_changed:
        _event(db, row, "rules-changed", admin, {"before": rules_before, "after": {"match": row.match, "rules": row.rules}})
    audit.record(db, "segment.update", resource_type="segments", resource_id=row.id, actor=admin,
                 summary=f"Changed segment {row.name}",
                 changes=audit.diff({**before, **rules_before}, {"name": row.name, "description": row.description,
                                                                 "match": row.match, "rules": row.rules}))
    db.commit()
    if rules_changed:
        recalculate(db, row, admin=admin, record=False)
    return row


def recalculate_now(db: Session, admin: AdminUser, segment_id) -> dict:
    from app.services import audit

    row = load(db, segment_id)
    if row.status == "archived":
        raise ConflictError("Restore this segment before recalculating it.", error_code="SEGMENT_ARCHIVED")
    result = recalculate(db, row, admin=admin, record=True)
    audit.record(db, "segment.recalculate", resource_type="segments", resource_id=row.id, actor=admin,
                 summary=f"Recalculated segment {row.name}: {result['before']} → {result['after']}", details=result)
    db.commit()
    return result


def set_archived(db: Session, admin: AdminUser, segment_id, archived: bool) -> Segment:
    from app.services import audit

    row = load(db, segment_id, lock=True)
    if (row.status == "archived") == archived:
        return row
    now = datetime.utcnow().replace(microsecond=0)
    row.status, row.archived_at = ("archived", now) if archived else ("active", None)
    row.updated_by, row.updated_at = admin.id, now
    _event(db, row, "archived" if archived else "restored", admin)
    audit.record(db, "segment.archive" if archived else "segment.restore", resource_type="segments",
                 resource_id=row.id, actor=admin, summary=f"{'Archived' if archived else 'Restored'} segment {row.name}")
    db.commit()
    if not archived:
        recalculate(db, row, admin=admin, record=False)
    return row


# ---------------------------------------------------------------------- views


def summary_view(segment: Segment) -> dict:
    return {
        "id": segment.id, "name": segment.name, "slug": segment.slug, "description": segment.description,
        "kind": segment.kind, "status": segment.status, "match": segment.match,
        "conditionCount": engine.count_conditions(segment.rules), "memberCount": segment.member_count,
        "lastCalculatedAt": segment.last_calculated_at, "createdBy": segment.created_by,
        "updatedBy": segment.updated_by, "createdAt": segment.created_at, "updatedAt": segment.updated_at,
        "archivedAt": segment.archived_at,
    }


def _distribution(db: Session, segment: Segment) -> dict:
    conf = metrics.settings(db)
    names = metrics.label_names(conf)
    member = SegmentMember.segment_id == segment.id
    def grouped(column):
        return dict(db.execute(select(column, func.count()).select_from(CustomerMetrics)
                               .join(SegmentMember, SegmentMember.customer_id == CustomerMetrics.customer_id)
                               .where(member).group_by(column)).all())

    labels = grouped(CustomerMetrics.rfm_label)
    order = [entry["key"] for entry in conf["labels"]] + [k for k in metrics.LABEL_KEYS if k not in
                                                         [e["key"] for e in conf["labels"]]] + ["no-orders"]
    out = {"labels": [{"key": k, "label": names.get(k, k), "count": int(labels.get(k, 0))} for k in order]}
    for name, column in (("recency", CustomerMetrics.recency_score), ("frequency", CustomerMetrics.frequency_score),
                         ("monetary", CustomerMetrics.monetary_score)):
        counts = grouped(column)
        out[name] = [{"score": s, "count": int(counts.get(s, 0))} for s in (5, 4, 3, 2, 1, 0)]
    return out


def history(db: Session, segment: Segment) -> List[dict]:
    rows = db.execute(select(SegmentEvent).where(SegmentEvent.segment_id == segment.id)
                      .order_by(SegmentEvent.occurred_at.desc(), SegmentEvent.id.desc()).limit(HISTORY_LIMIT)).scalars()
    return [{"id": r.id, "action": r.action, "label": ACTION_LABELS.get(r.action, r.action), "actor": r.actor,
             "actorName": r.actor_name or ("System" if r.actor == "system" else r.actor), "details": r.details or {},
             "at": r.occurred_at} for r in rows]


def detail(db: Session, admin: AdminUser, segment: Segment) -> dict:
    active = segment.status == "active"
    return {
        **summary_view(segment), "rules": segment.rules, "rfm": _distribution(db, segment),
        "history": history(db, segment),
        "actions": {"edit": active, "archive": active, "restore": not active, "recalculate": active,
                    "export": can_export(admin)},
    }


def list_segments(db: Session, *, q: str = "", status: str = "active", kind: str = "", page: int = 1,
                  page_size: int = 25) -> tuple:
    ensure_defaults(db)
    conditions = []
    if status in ("active", "archived"):
        conditions.append(Segment.status == status)
    if kind in ("default", "custom"):
        conditions.append(Segment.kind == kind)
    # A Segment ID, exactly (docs/id-lookup.md): names and descriptions match nothing.
    condition = id_condition("segment", q)
    if condition is not None:
        conditions.append(condition)
    counts = dict(db.execute(select(Segment.status, func.count()).group_by(Segment.status)).all())
    total = db.execute(select(func.count()).select_from(Segment).where(*conditions)).scalar_one()
    rows = db.execute(select(Segment).where(*conditions).order_by(Segment.kind.desc(), Segment.name)
                      .offset((page - 1) * page_size).limit(page_size)).scalars().all()
    return ([summary_view(r) for r in rows], int(total),
            {"active": int(counts.get("active", 0)), "archived": int(counts.get("archived", 0))})


def active_choices(db: Session) -> List[dict]:
    ensure_defaults(db)
    rows = db.execute(select(Segment).where(Segment.status == "active").order_by(Segment.name)).scalars()
    return [{"id": r.id, "name": r.name, "memberCount": r.member_count, "lastCalculatedAt": r.last_calculated_at}
            for r in rows]


# ------------------------------------------------------------- members/preview


def _member_columns():
    return (Customer.id, Customer.first_name, Customer.last_name, Customer.email, Customer.phone, Customer.joined_at,
            CustomerMetrics.city, CustomerMetrics.state, CustomerMetrics.total_orders, CustomerMetrics.total_spend,
            CustomerMetrics.average_order_value, CustomerMetrics.last_order_at, CustomerMetrics.rfm_label,
            CustomerMetrics.recency_score, CustomerMetrics.frequency_score, CustomerMetrics.monetary_score,
            CustomerMetrics.points_balance)


def _member(row, masked: bool, added_at=None) -> dict:
    (cid, first, last, email, phone, joined, city, state, orders, spend, aov, last_order, label, r, f, m,
     points) = row[:17]
    return {
        "customerId": cid, "name": f"{first} {last}".strip(),
        "email": mask_email(email) if masked else email, "phone": mask_phone(phone) if masked else phone,
        "city": city, "state": state, "totalOrders": int(orders), "totalSpend": int(spend) / 100,
        "averageOrderValue": int(aov) / 100, "lastOrderAt": last_order, "joinedAt": joined, "rfmLabel": label,
        "rfmScore": f"{r}{f}{m}", "pointsBalance": int(points), "addedAt": added_at,
    }


def preview(db: Session, admin: AdminUser, payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValidationError("Send the rules as an object.", error_code="INVALID_SEGMENT")
    match, rule_list = engine.clean(payload.get("match", "all"), payload.get("rules", []), db)
    page, size = payload.get("page", 1), payload.get("pageSize", 10)
    page = page if isinstance(page, int) and not isinstance(page, bool) and 1 <= page <= 10_000 else 1
    size = size if isinstance(size, int) and not isinstance(size, bool) and 1 <= size <= PREVIEW_PAGE_MAX else 10
    condition = engine.compile_rules(match, rule_list)
    count = db.execute(select(func.count()).select_from(engine.base_query(Customer.id).where(condition).subquery())
                       ).scalar_one()
    masked = not can_export(admin)
    rows = db.execute(engine.base_query(*_member_columns()).where(condition).order_by(Customer.id)
                      .offset((page - 1) * size).limit(size)).all()
    return {"count": int(count), "items": [_member(r, masked) for r in rows], "page": page, "pageSize": size,
            "masked": masked}


def members(db: Session, admin: AdminUser, segment_id, *, q: str = "", page: int = 1, page_size: int = 25) -> tuple:
    segment = load(db, segment_id)
    conditions = [SegmentMember.segment_id == segment.id]
    # A Customer ID, exactly (docs/id-lookup.md): names, emails and phones match nothing.
    condition = id_condition("customer", q)
    if condition is not None:
        conditions.append(condition)
    base = (select(*_member_columns(), SegmentMember.added_at).select_from(SegmentMember)
            .join(Customer, Customer.id == SegmentMember.customer_id)
            .join(CustomerMetrics, CustomerMetrics.customer_id == Customer.id).where(*conditions))
    total = db.execute(select(func.count()).select_from(base.subquery())).scalar_one()
    masked = not can_export(admin)
    rows = db.execute(base.order_by(Customer.id).offset((page - 1) * page_size).limit(page_size)).all()
    return [_member(r, masked, r[17]) for r in rows], int(total), masked


def _safe(value) -> str:
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


EXPORT_HEADER = ["Customer ID", "First name", "Last name", "Email", "Phone", "City", "State", "Pincode",
                 "Registered", "Orders", "Total spend (₹)", "Average order value (₹)", "Last order", "RFM group",
                 "RFM score", "Reward points", "Store credit (₹)", "Membership", "Added to segment"]


def export_csv(db: Session, admin: AdminUser, segment_id) -> tuple:
    """Every member, unmasked, as CSV. Audited, and recorded in the history. Returns (filename, text)."""
    from app.services import audit

    segment = load(db, segment_id)
    names = metrics.label_names(metrics.settings(db))
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(EXPORT_HEADER)
    last, count = "", 0
    while True:
        rows = db.execute(
            select(Customer.id, Customer.first_name, Customer.last_name, Customer.email, Customer.phone,
                   CustomerMetrics.city, CustomerMetrics.state, CustomerMetrics.pincode, Customer.joined_at,
                   CustomerMetrics.total_orders, CustomerMetrics.total_spend, CustomerMetrics.average_order_value,
                   CustomerMetrics.last_order_at, CustomerMetrics.rfm_label, CustomerMetrics.recency_score,
                   CustomerMetrics.frequency_score, CustomerMetrics.monetary_score, CustomerMetrics.points_balance,
                   CustomerMetrics.store_credit_balance, CustomerMetrics.membership_status, SegmentMember.added_at)
            .select_from(SegmentMember).join(Customer, Customer.id == SegmentMember.customer_id)
            .join(CustomerMetrics, CustomerMetrics.customer_id == Customer.id)
            .where(SegmentMember.segment_id == segment.id, Customer.id > last)
            .order_by(Customer.id).limit(EXPORT_CHUNK)).all()
        if not rows:
            break
        for (cid, first, last_name, email, phone, city, state, pincode, joined, orders, spend, aov, last_order,
             label, r, f, m, points, credit, membership, added) in rows:
            writer.writerow([_safe(v) for v in (
                cid, first, last_name, email, phone, city, state, pincode, joined.date().isoformat() if joined else "",
                orders, f"{int(spend) / 100:.2f}", f"{int(aov) / 100:.2f}",
                last_order.date().isoformat() if last_order else "", names.get(label, label), f"{r}{f}{m}", points,
                f"{int(credit) / 100:.2f}", membership, added.date().isoformat() if added else "")])
        count += len(rows)
        last = rows[-1][0]
    _event(db, segment, "exported", admin, {"rows": count})
    audit.record(db, "segment.export", resource_type="segments", resource_id=segment.id, actor=admin,
                 summary=f"Exported segment {segment.name} ({count} customers)", details={"rows": count})
    db.commit()
    filename = f"segment-{segment.slug}-{datetime.utcnow():%Y-%m-%d}.csv"
    return filename, out.getvalue()


# ------------------------------------------------------- campaigns & coupons


def member_ids_query(db: Session, segment_id):
    """For campaigns: the segment's materialised members. Unknown → SEGMENT_NOT_FOUND; archived → SEGMENT_ARCHIVED."""
    segment = db.get(Segment, segment_id)
    if segment is None:
        raise ValidationError("That segment no longer exists. Choose another.", error_code="SEGMENT_NOT_FOUND")
    if segment.status != "active":
        raise ValidationError(f"The segment “{segment.name}” is archived. Restore it or choose another.",
                              error_code="SEGMENT_ARCHIVED")
    return select(SegmentMember.customer_id).where(SegmentMember.segment_id == segment.id)


def require_active(db: Session, segment_id) -> Segment:
    """For saving a coupon: the segment must exist and be active."""
    if segment_id in (None, ""):
        raise ValidationError("Choose the segment this coupon is for.", error_code="SEGMENT_REQUIRED")
    try:
        key = int(segment_id)
    except (TypeError, ValueError):
        raise ValidationError("Choose the segment this coupon is for.", error_code="SEGMENT_REQUIRED") from None
    segment = db.get(Segment, key)
    if segment is None:
        raise ValidationError("That segment no longer exists.", error_code="SEGMENT_NOT_FOUND")
    if segment.status != "active":
        raise ValidationError(f"The segment “{segment.name}” is archived.", error_code="SEGMENT_ARCHIVED")
    return segment


def matches_now(db: Session, segment_id: Optional[int], customer_id: str) -> bool:
    """Live: does this customer match the segment's rules right now? False for a missing or archived segment."""
    segment = db.get(Segment, segment_id) if segment_id else None
    if segment is None or segment.status != "active" or not customer_id:
        return False
    query = engine.matching_ids(segment.match, segment.rules).where(Customer.id == customer_id)
    if db.execute(query).first():
        return True
    # A customer the job hasn't reached yet: compute their figures now and ask again.
    # Asked of the table, not the session's identity map: a row removed by a bulk statement can still
    # be cached there.
    has_metrics = db.execute(select(CustomerMetrics.customer_id)
                             .where(CustomerMetrics.customer_id == customer_id)).first() is not None
    if not has_metrics:
        metrics.refresh(db, [customer_id])
        return db.execute(query).first() is not None
    return False


# ------------------------------------------------------------------- summary


def summary(db: Session) -> dict:
    """Headline numbers for the admin dashboard, from the precomputed metrics."""
    ensure_defaults(db)
    now = datetime.utcnow()
    total = db.execute(select(func.count()).select_from(Customer)).scalar_one()
    new = db.execute(select(func.count()).select_from(Customer)
                     .where(Customer.joined_at >= now - timedelta(days=30))).scalar_one()
    returning = db.execute(select(func.count()).select_from(CustomerMetrics)
                           .where(CustomerMetrics.total_orders >= 2)).scalar_one()
    at_risk = db.execute(select(func.count()).select_from(CustomerMetrics)
                         .where(CustomerMetrics.rfm_label == "at-risk")).scalar_one()
    vip = db.execute(select(Segment.member_count).where(Segment.slug == "vip", Segment.status == "active")
                     ).scalar_one_or_none()
    active = db.execute(select(func.count()).select_from(Segment).where(Segment.status == "active")).scalar_one()
    oldest = db.execute(select(func.min(CustomerMetrics.refreshed_at))).scalar_one_or_none()
    return {"totalCustomers": int(total), "newCustomers30d": int(new), "returningCustomers": int(returning),
            "vip": int(vip or 0), "atRisk": int(at_risk), "activeSegments": int(active), "oldestRefreshAt": oldest}


def refresh_everything(db: Session, admin: Optional[AdminUser] = None) -> dict:
    """Full metrics refresh, then every active segment recalculated in full."""
    from app.services import audit

    ensure_defaults(db)
    refreshed = metrics.refresh_all(db)
    segments = recalculate_active(db)
    if admin is not None:
        audit.record(db, "segments.refresh", resource_type="segments", resource_id="metrics", actor=admin,
                     summary=f"Refreshed customer metrics ({refreshed} customers, {segments} segments)")
        db.commit()
    return {"refreshed": refreshed, "segments": segments}
