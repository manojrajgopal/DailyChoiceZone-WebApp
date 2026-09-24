"""Load the demo data into MySQL, once.

**Idempotent by primary key.** Every record is inserted only if its id is not
already present, so restarting the application neither duplicates anything nor
overwrites a change somebody made through the portal. That second half matters
as much as the first: a seeder that re-wrote rows on every boot would quietly
undo an administrator's work every time the process restarted.

The demo ids (`prod_001`, `order_0005`) are translated to the `PRD001` scheme
on the way in, and every reference between records is translated with them —
see `IdMap`.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional, Set

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.core.security import hash_password
from app.models import (
    Address,
    AdminUser,
    Banner,
    Category,
    Collection,
    CollectionProduct,
    Coupon,
    CreditNote,
    Customer,
    HomepageSection,
    Invoice,
    InvoiceItem,
    Notification,
    Order,
    OrderEvent,
    OrderItem,
    Payment,
    PaymentEvent,
    Product,
    ProductColor,
    ProductImage,
    ProductSize,
    ProductSpecification,
    ProductTag,
    Refund,
    RefundItem,
    Review,
    SettingDocument,
    WishlistItem,
)
from app.seed.json_loader import IdMap, load, numeric_sort_key, parse_dt

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Demo credentials.
#
# The seeded accounts need a password and the JSON has none. These are written
# ONLY by the seeder, which must be off in production (`AUTO_SEED=false`, and
# `Settings.validate_production` refuses to start otherwise).
#
# They are hashed like any other password — there is no plaintext column to put
# them in even if someone wanted to.
# ---------------------------------------------------------------------------
DEMO_CUSTOMER_PASSWORD = "Customer@123"
DEMO_ADMIN_PASSWORD = "Admin@123"


def _existing_ids(db: Session, model) -> Set[str]:
    """Ids already in the table — one query instead of one per record."""
    return set(db.execute(select(model.id)).scalars().all())


def _is_empty(db: Session, model) -> bool:
    return db.execute(select(func.count()).select_from(model)).scalar_one() == 0


# ---------------------------------------------------------------------------
# id mapping
# ---------------------------------------------------------------------------


def build_id_map() -> IdMap:
    """
    Work out every new id before writing anything.

    Built from the source files rather than from the database, so the mapping
    is the same on a first run and on a re-run — which is what lets the
    insert-if-absent checks below recognise a record they have already seen.
    """
    ids = IdMap()

    products = load("products.json")
    ids.build("product", "PRD", [p["id"] for p in sorted(products, key=lambda p: numeric_sort_key(p["id"]))])

    categories = load("categories.json")
    ids.build("category", "CAT", [c["id"] for c in sorted(categories, key=lambda c: c.get("order", 0))])

    collections = load("collections.json")
    ids.build("collection", "COL", [c["id"] for c in collections])

    customers = load("admin/customers.json")
    ids.build("customer", "CUS", [c["id"] for c in sorted(customers, key=lambda c: numeric_sort_key(c["id"]))])

    # Addresses are numbered across all customers, in customer order.
    address_ids = [
        address["id"]
        for customer in sorted(customers, key=lambda c: numeric_sort_key(c["id"]))
        for address in customer.get("addresses", [])
    ]
    ids.build("address", "ADR", address_ids)

    orders = load("admin/orders.json")
    ids.build("order", "ORD", [o["id"] for o in sorted(orders, key=lambda o: numeric_sort_key(o["id"]))])

    coupons = load("admin/coupons.json")
    ids.build("coupon", "CPN", [c["id"] for c in coupons])

    # Review ids are `rev_001_1`, so they are numbered by appearance rather
    # than parsed. Sorted by product then index to keep the order stable.
    reviews = load("admin/reviews.json")
    ids.build("review", "REV", [r["id"] for r in sorted(reviews, key=lambda r: numeric_sort_key(r["id"]))])

    banners = load("admin/banners.json")
    ids.build("banner", "BNR", [b["id"] for b in banners])

    admins = load("admin/admin-users.json")
    ids.build("admin_user", "ADM", [a["id"] for a in admins])

    invoices = load("billing/invoices.json")
    ids.build("invoice", "INV", [i["id"] for i in sorted(invoices, key=lambda i: numeric_sort_key(i["id"]))])

    payments = load("billing/payments.json")
    ids.build("payment", "PAY", [p["id"] for p in sorted(payments, key=lambda p: numeric_sort_key(p["id"]))])

    refunds = load("billing/refunds.json")
    ids.build("refund", "RFN", [r["id"] for r in sorted(refunds, key=lambda r: numeric_sort_key(r["id"]))])

    notes = load("billing/credit-notes.json")
    ids.build("credit_note", "CRN", [n["id"] for n in sorted(notes, key=lambda n: numeric_sort_key(n["id"]))])

    return ids


# ---------------------------------------------------------------------------
# catalogue
# ---------------------------------------------------------------------------


def seed_categories(db: Session, ids: IdMap) -> int:
    existing = _existing_ids(db, Category)
    added = 0

    for raw in load("categories.json"):
        new_id = ids.require("category", raw["id"])
        if new_id in existing:
            continue

        db.add(
            Category(
                id=new_id,
                slug=raw["slug"],
                name=raw["name"],
                description=raw.get("description", ""),
                image=raw.get("image", ""),
                display_order=raw.get("order", 0),
                featured=bool(raw.get("featured", False)),
                groups=raw.get("groups", []),
            )
        )
        added += 1

    return added


def seed_products(db: Session, ids: IdMap) -> int:
    """
    Products, with their images, colours, sizes, specifications and tags.

    The customer fields and the management fields are two files joined by id in
    the frontend; here they are one row, which is what the shared product model
    always described.
    """
    existing = _existing_ids(db, Product)
    meta_by_product = {m["productId"]: m for m in load("admin/product-meta.json")}
    category_by_slug = {c["slug"]: ids.require("category", c["id"]) for c in load("categories.json")}

    added = 0
    for raw in load("products.json"):
        new_id = ids.require("product", raw["id"])
        if new_id in existing:
            continue

        meta = meta_by_product.get(raw["id"], {})
        seo = meta.get("seo", {})

        product = Product(
            id=new_id,
            slug=raw["slug"],
            sku=raw["sku"],
            name=raw["name"],
            brand=raw["brand"],
            category_id=category_by_slug[raw["category"]],
            subcategory=raw.get("subcategory", ""),
            price=raw["price"],
            original_price=raw.get("originalPrice", raw["price"]),
            discount=raw.get("discount", 0),
            currency=raw.get("currency", "INR"),
            description=raw.get("description", ""),
            material=raw.get("material", ""),
            care=raw.get("care", ""),
            rating=raw.get("rating", 0),
            review_count=raw.get("reviewCount", 0),
            is_new=bool(raw.get("isNew")),
            is_trending=bool(raw.get("isTrending")),
            is_best_seller=bool(raw.get("isBestSeller")),
            is_featured=bool(raw.get("isFeatured")),
            status=meta.get("status", "active"),
            stock=raw.get("stock", 0),
            reserved_stock=meta.get("reservedStock", 0),
            low_stock_threshold=meta.get("lowStockThreshold", 8),
            barcode=meta.get("barcode", ""),
            tax_rate_percent=meta.get("taxRatePercent", 5),
            meta_title=seo.get("metaTitle", ""),
            meta_description=seo.get("metaDescription", ""),
            updated_by=ids.get("admin_user", meta.get("updatedBy")),
            created_at=parse_dt(meta.get("createdAt")) or datetime.utcnow(),
            updated_at=parse_dt(meta.get("updatedAt")) or datetime.utcnow(),
        )

        product.images = [
            ProductImage(url=url, position=index) for index, url in enumerate(raw.get("images", []))
        ]
        product.colors = [
            ProductColor(name=color["name"], hex=color.get("hex", "#000000"), position=index)
            for index, color in enumerate(raw.get("colors", []))
        ]
        product.sizes = [
            ProductSize(label=label, position=index) for index, label in enumerate(raw.get("sizes", []))
        ]
        product.specifications = [
            ProductSpecification(label=spec["label"], value=spec["value"], position=index)
            for index, spec in enumerate(raw.get("specifications", []))
        ]
        # De-duplicated: the unique constraint would reject a repeated tag, and
        # the demo data has a few.
        product.tags = [
            ProductTag(tag=tag) for tag in dict.fromkeys(raw.get("tags", []))
        ]

        db.add(product)
        added += 1

    return added


def seed_collections(db: Session, ids: IdMap) -> int:
    existing = _existing_ids(db, Collection)
    added = 0

    for raw in load("collections.json"):
        new_id = ids.require("collection", raw["id"])
        if new_id in existing:
            continue

        collection = Collection(
            id=new_id,
            slug=raw["slug"],
            name=raw["name"],
            tagline=raw.get("tagline", ""),
            description=raw.get("description", ""),
            image=raw.get("image", ""),
            featured=bool(raw.get("featured", False)),
        )
        collection.items = [
            CollectionProduct(product_id=ids.require("product", product_id), position=index)
            for index, product_id in enumerate(raw.get("productIds", []))
            if ids.known("product", product_id)
        ]

        db.add(collection)
        added += 1

    return added


# ---------------------------------------------------------------------------
# people
# ---------------------------------------------------------------------------


def seed_customers(db: Session, ids: IdMap) -> int:
    existing = _existing_ids(db, Customer)

    # Hashed once and reused: bcrypt on 64 customers individually adds about a
    # minute to a first run for no benefit, since the password is the same.
    password_hash = hash_password(DEMO_CUSTOMER_PASSWORD)

    added = 0
    for raw in load("admin/customers.json"):
        new_id = ids.require("customer", raw["id"])
        if new_id in existing:
            continue

        customer = Customer(
            id=new_id,
            email=raw["email"],
            password_hash=password_hash,
            first_name=raw["firstName"],
            last_name=raw.get("lastName", ""),
            phone=raw.get("phone", ""),
            status=raw.get("status", "active"),
            joined_at=parse_dt(raw.get("joinedAt")) or datetime.utcnow(),
        )
        customer.addresses = [
            Address(
                id=ids.require("address", address["id"]),
                full_name=address["fullName"],
                phone=address.get("phone", ""),
                line1=address.get("line1", ""),
                line2=address.get("line2", ""),
                city=address.get("city", ""),
                state=address.get("state", ""),
                pincode=address.get("pincode", ""),
                type=address.get("type", "home"),
                is_default=bool(address.get("isDefault", False)),
            )
            for address in raw.get("addresses", [])
        ]

        db.add(customer)
        added += 1

    return added


def seed_wishlists(db: Session, ids: IdMap) -> int:
    """The wishlists the demo customers already have."""
    if not _is_empty(db, WishlistItem):
        return 0

    added = 0
    for raw in load("admin/customers.json"):
        customer_id = ids.require("customer", raw["id"])
        for product_id in dict.fromkeys(raw.get("wishlistProductIds", [])):
            if not ids.known("product", product_id):
                continue
            db.add(
                WishlistItem(
                    customer_id=customer_id,
                    product_id=ids.require("product", product_id),
                )
            )
            added += 1

    return added


def seed_admin_users(db: Session, ids: IdMap) -> int:
    existing = _existing_ids(db, AdminUser)
    password_hash = hash_password(DEMO_ADMIN_PASSWORD)

    # What each role may do. The vocabulary the portal's `can()` already uses,
    # and every role the portal can assign — a role missing from this map would
    # seed an administrator who is allowed nothing.
    permissions_by_role = {
        "super-admin": [
            "products", "orders", "customers", "coupons", "reviews",
            "content", "reports", "settings", "admins",
        ],
        "admin": [
            "products", "orders", "customers", "coupons", "reviews",
            "content", "reports", "settings",
        ],
        "manager": ["products", "orders", "customers", "reviews", "reports"],
        "editor": ["products", "content"],
        "staff": ["products", "orders", "reviews"],
    }

    added = 0
    for raw in load("admin/admin-users.json"):
        new_id = ids.require("admin_user", raw["id"])
        if new_id in existing:
            continue

        db.add(
            AdminUser(
                id=new_id,
                email=raw["email"],
                password_hash=password_hash,
                name=raw["name"],
                role=raw.get("role", "staff"),
                permissions=permissions_by_role.get(raw.get("role", "staff"), []),
                status=raw.get("status", "active"),
                last_login_at=parse_dt(raw.get("lastLoginAt")),
                created_at=parse_dt(raw.get("createdAt")) or datetime.utcnow(),
            )
        )
        added += 1

    return added


# ---------------------------------------------------------------------------
# orders
# ---------------------------------------------------------------------------


def seed_orders(db: Session, ids: IdMap) -> int:
    existing = _existing_ids(db, Order)
    product_slug_by_id = {p["id"]: p["slug"] for p in load("products.json")}
    product_brand_by_id = {p["id"]: p["brand"] for p in load("products.json")}

    added = 0
    for raw in load("admin/orders.json"):
        new_id = ids.require("order", raw["id"])
        if new_id in existing:
            continue

        totals = raw.get("totals", {})
        address = raw.get("shippingAddress", {})
        placed_at = parse_dt(raw.get("placedAt")) or datetime.utcnow()

        order = Order(
            id=new_id,
            order_number=raw["orderNumber"],
            customer_id=ids.require("customer", raw["customerId"]),
            customer_name=raw.get("customerName", ""),
            customer_email=raw.get("customerEmail", ""),
            placed_at=placed_at,
            status=raw.get("status", "pending"),
            payment_status=raw.get("paymentStatus", "pending"),
            payment_method=raw.get("paymentMethod", ""),
            delivery_fee=totals.get("deliveryFee", 0),
            tracking_number=raw.get("trackingNumber"),
            item_count=totals.get("itemCount", 0),
            subtotal=totals.get("subtotal", 0),
            catalogue_savings=totals.get("catalogueSavings", 0),
            coupon_code=(totals.get("appliedCoupon") or {}).get("code"),
            coupon_discount=totals.get("couponDiscount", 0),
            tax_amount=totals.get("taxAmount", 0),
            total=totals.get("total", 0),
            shipping_name=address.get("fullName", ""),
            shipping_phone=address.get("phone", ""),
            shipping_line1=address.get("line1", ""),
            shipping_line2=address.get("line2", ""),
            shipping_city=address.get("city", ""),
            shipping_state=address.get("state", ""),
            shipping_pincode=address.get("pincode", ""),
            created_at=placed_at,
        )

        order.items = [
            OrderItem(
                product_id=ids.require("product", line["productId"]),
                name=line["name"],
                sku=line.get("sku", ""),
                slug=product_slug_by_id.get(line["productId"], ""),
                brand=product_brand_by_id.get(line["productId"], ""),
                image=line.get("image", ""),
                size=line.get("size"),
                color=line.get("color"),
                quantity=line.get("quantity", 1),
                unit_price=line.get("unitPrice", 0),
                line_total=line.get("lineTotal", 0),
            )
            for line in raw.get("lines", [])
            if ids.known("product", line["productId"])
        ]

        order.events = [
            OrderEvent(
                status=event["status"],
                note=event.get("note", ""),
                actor=ids.get("admin_user", event.get("by")) or "system",
                occurred_at=parse_dt(event.get("at")) or placed_at,
            )
            for event in raw.get("timeline", [])
        ]

        db.add(order)
        added += 1

    return added


# ---------------------------------------------------------------------------
# commerce
# ---------------------------------------------------------------------------


def seed_coupons(db: Session, ids: IdMap) -> int:
    existing = _existing_ids(db, Coupon)
    added = 0

    for raw in load("admin/coupons.json"):
        new_id = ids.require("coupon", raw["id"])
        if new_id in existing:
            continue

        db.add(
            Coupon(
                id=new_id,
                code=raw["code"],
                description=raw.get("description", ""),
                type=raw.get("type", "percent"),
                value=raw.get("value", 0),
                min_subtotal=raw.get("minSubtotal", 0),
                max_discount=raw.get("maxDiscount"),
                starts_at=parse_dt(raw.get("startsAt")) or datetime.utcnow(),
                ends_at=parse_dt(raw.get("endsAt")),
                usage_limit=raw.get("usageLimit"),
                usage_count=raw.get("usageCount", 0),
                # The demo data has no per-customer cap; the column exists for
                # coupons that need one.
                per_customer_limit=raw.get("perCustomerLimit"),
                active=raw.get("status", "active") != "disabled",
                created_at=parse_dt(raw.get("createdAt")) or datetime.utcnow(),
            )
        )
        added += 1

    return added


def seed_reviews(db: Session, ids: IdMap) -> int:
    """
    Reviews, merged from the two projections of them.

    `reviews.json` holds what a product page renders — author, date, verified.
    `admin/reviews.json` holds the moderation state and who wrote it. Same ids,
    so the merge is a lookup.
    """
    existing = _existing_ids(db, Review)
    storefront = {r["id"]: r for r in load("reviews.json")}

    added = 0
    seen_keys: Set[tuple] = set()

    for raw in load("admin/reviews.json"):
        new_id = ids.require("review", raw["id"])
        if new_id in existing:
            continue

        if not ids.known("product", raw["productId"]):
            continue

        front = storefront.get(raw["id"], {})
        customer_id = ids.get("customer", raw.get("customerId")) if ids.known("customer", raw.get("customerId")) else None

        # The unique constraint is (product, customer, title). The demo data
        # has a handful of collisions; skipping them is better than failing the
        # whole seed on data that was never meant to be unique.
        key = (ids.require("product", raw["productId"]), customer_id, raw.get("title", ""))
        if key in seen_keys:
            continue
        seen_keys.add(key)

        db.add(
            Review(
                id=new_id,
                product_id=ids.require("product", raw["productId"]),
                customer_id=customer_id,
                author=front.get("author") or raw.get("customerName", "Anonymous"),
                rating=raw.get("rating", 5),
                title=raw.get("title", ""),
                body=raw.get("body", ""),
                verified_purchase=bool(front.get("verified", raw.get("verifiedPurchase", False))),
                status=raw.get("status", "pending"),
                submitted_at=parse_dt(raw.get("submittedAt") or front.get("date")) or datetime.utcnow(),
            )
        )
        added += 1

    return added


def seed_banners(db: Session, ids: IdMap) -> int:
    existing = _existing_ids(db, Banner)
    added = 0

    for raw in load("admin/banners.json"):
        new_id = ids.require("banner", raw["id"])
        if new_id in existing:
            continue

        db.add(
            Banner(
                id=new_id,
                title=raw["title"],
                subtitle=raw.get("subtitle", ""),
                image=raw.get("image", ""),
                button_text=raw.get("buttonText", ""),
                button_link=raw.get("buttonLink", ""),
                starts_at=parse_dt(raw.get("startsAt")) or datetime.utcnow(),
                ends_at=parse_dt(raw.get("endsAt")),
                active=bool(raw.get("active", True)),
                display_order=raw.get("displayOrder", 0),
            )
        )
        added += 1

    return added


def seed_homepage(db: Session) -> int:
    """
    Homepage sections: the definition and the editorial state, merged.

    `homepage.json` says what each section is; `admin/homepage.json` says
    whether it runs and where. They share ids, which is the join.
    """
    existing = _existing_ids(db, HomepageSection)
    admin_by_id = {s["id"]: s for s in load("admin/homepage.json")}

    added = 0
    for index, raw in enumerate(load("homepage.json")["sections"], start=1):
        if raw["id"] in existing:
            continue

        admin = admin_by_id.get(raw["id"], {})

        # Everything the renderer needs that is specific to one section type.
        config = {
            key: value
            for key, value in raw.items()
            if key not in {"id", "type", "title", "subtitle", "source", "limit"}
        }

        db.add(
            HomepageSection(
                id=raw["id"],
                type=raw["type"],
                title=raw.get("title", admin.get("title", "")),
                subtitle=raw.get("subtitle", admin.get("subtitle", "")),
                source=raw.get("source"),
                item_limit=raw.get("limit", 0),
                config=config,
                active=bool(admin.get("active", True)),
                display_order=admin.get("displayOrder", index),
            )
        )
        added += 1

    return added


def seed_notifications(db: Session) -> int:
    existing = _existing_ids(db, Notification)
    added = 0

    for raw in load("admin/notifications.json"):
        if raw["id"] in existing:
            continue

        db.add(
            Notification(
                id=raw["id"],
                kind=raw.get("kind", "system"),
                title=raw["title"],
                body=raw.get("body", ""),
                href=raw.get("href", ""),
                read=bool(raw.get("read", False)),
                created_at=parse_dt(raw.get("at")) or datetime.utcnow(),
            )
        )
        added += 1

    return added


def seed_settings(db: Session) -> int:
    """
    The configuration documents.

    Four keys, each a whole document: the store settings, the billing config,
    the tax config, and the site config the storefront chrome reads.
    """
    existing = set(db.execute(select(SettingDocument.key)).scalars().all())

    documents = {
        "store": load("admin/settings.json"),
        "billing": load("billing/billing-config.json"),
        "tax": load("billing/tax-config.json"),
        "site": load("site-config.json"),
    }

    added = 0
    for key, value in documents.items():
        if key in existing:
            continue
        db.add(SettingDocument(key=key, value=value))
        added += 1

    return added


# ---------------------------------------------------------------------------
# billing
# ---------------------------------------------------------------------------


def seed_invoices(db: Session, ids: IdMap) -> int:
    existing = _existing_ids(db, Invoice)
    added = 0

    for raw in load("billing/invoices.json"):
        new_id = ids.require("invoice", raw["id"])
        if new_id in existing:
            continue

        breakdown = raw["breakdown"]
        tax = breakdown["tax"]

        invoice = Invoice(
            id=new_id,
            invoice_number=raw["invoiceNumber"],
            order_id=ids.require("order", raw["orderId"]),
            order_number=raw.get("orderNumber", ""),
            customer_id=ids.require("customer", raw["customerId"]),
            customer_name=raw.get("customerName", ""),
            customer_email=raw.get("customerEmail", ""),
            status=raw.get("status", "issued"),
            issued_at=parse_dt(raw["issuedAt"]),
            due_at=parse_dt(raw["dueAt"]),
            billing_address=raw.get("billingAddress", {}),
            shipping_address=raw.get("shippingAddress", {}),
            place_of_supply=raw.get("placeOfSupply", ""),
            currency=breakdown.get("currency", "INR"),
            item_count=breakdown.get("itemCount", 0),
            subtotal=breakdown.get("subtotal", 0),
            product_discount=breakdown.get("productDiscount", 0),
            coupon_code=breakdown.get("couponCode"),
            coupon_discount=breakdown.get("couponDiscount", 0),
            shipping=breakdown.get("shipping", 0),
            other_charges=breakdown.get("otherCharges", 0),
            taxable_amount=tax.get("taxableAmount", 0),
            tax_mode=tax.get("mode", "none"),
            tax_rate_percent=tax.get("ratePercent", 0),
            cgst=tax.get("cgst", 0),
            sgst=tax.get("sgst", 0),
            igst=tax.get("igst", 0),
            total_tax=tax.get("totalTax", 0),
            prices_include_tax=bool(breakdown.get("pricesIncludeTax", True)),
            grand_total=breakdown.get("grandTotal", 0),
            amount_paid=raw.get("amountPaid", 0),
            amount_refunded=raw.get("amountRefunded", 0),
            payment_id=ids.get("payment", raw.get("paymentId")),
            payment_method=raw.get("paymentMethod", "card"),
            payment_status=raw.get("paymentStatus", "pending"),
            notes=raw.get("notes", ""),
            terms=raw.get("terms", ""),
        )

        invoice.items = [
            InvoiceItem(
                product_id=ids.get("product", line["productId"]),
                name=line["name"],
                sku=line.get("sku", ""),
                hsn=line.get("hsn", ""),
                size=line.get("size"),
                color=line.get("color"),
                quantity=line.get("quantity", 1),
                unit_price=line.get("unitPrice", 0),
                line_subtotal=line.get("lineSubtotal", 0),
                discount=line.get("discount", 0),
                taxable_amount=line.get("taxableAmount", 0),
                tax_rate_percent=line.get("taxRatePercent", 0),
                cgst=line.get("cgst", 0),
                sgst=line.get("sgst", 0),
                igst=line.get("igst", 0),
                tax=line.get("tax", 0),
                line_total=line.get("lineTotal", 0),
            )
            for line in raw.get("lines", [])
        ]

        db.add(invoice)
        added += 1

    return added


def seed_payments(db: Session, ids: IdMap) -> int:
    existing = _existing_ids(db, Payment)
    added = 0

    for raw in load("billing/payments.json"):
        new_id = ids.require("payment", raw["id"])
        if new_id in existing:
            continue

        created = parse_dt(raw["createdAt"])

        payment = Payment(
            id=new_id,
            transaction_id=raw["transactionId"],
            order_id=ids.require("order", raw["orderId"]),
            order_number=raw.get("orderNumber", ""),
            invoice_id=ids.require("invoice", raw["invoiceId"]),
            invoice_number=raw.get("invoiceNumber", ""),
            customer_id=ids.require("customer", raw["customerId"]),
            customer_name=raw.get("customerName", ""),
            customer_email=raw.get("customerEmail", ""),
            amount=raw.get("amount", 0),
            refunded_amount=raw.get("refundedAmount", 0),
            method=raw.get("method", "card"),
            status=raw.get("status", "pending"),
            provider=raw.get("provider", "mock"),
            instrument_hint=raw.get("instrumentHint", ""),
            created_at_utc=created,
            captured_at=parse_dt(raw.get("capturedAt")),
            created_at=created,
        )

        payment.events = [
            PaymentEvent(
                status=event["status"],
                note=event.get("note", ""),
                occurred_at=parse_dt(event["at"]) or created,
            )
            for event in raw.get("timeline", [])
        ]

        db.add(payment)
        added += 1

    return added


def seed_refunds(db: Session, ids: IdMap) -> int:
    existing = _existing_ids(db, Refund)
    added = 0

    for raw in load("billing/refunds.json"):
        new_id = ids.require("refund", raw["id"])
        if new_id in existing:
            continue

        refund = Refund(
            id=new_id,
            refund_number=raw["refundNumber"],
            order_id=ids.require("order", raw["orderId"]),
            order_number=raw.get("orderNumber", ""),
            invoice_id=ids.require("invoice", raw["invoiceId"]),
            invoice_number=raw.get("invoiceNumber", ""),
            payment_id=ids.require("payment", raw["paymentId"]),
            customer_id=ids.require("customer", raw["customerId"]),
            customer_name=raw.get("customerName", ""),
            amount=raw.get("amount", 0),
            reason=raw.get("reason", ""),
            status=raw.get("status", "requested"),
            requested_at=parse_dt(raw["requestedAt"]),
            processed_at=parse_dt(raw.get("processedAt")),
            credit_note_id=ids.get("credit_note", raw.get("creditNoteId")),
            initiated_by=ids.get("admin_user", raw.get("initiatedBy")) or "customer",
        )

        refund.items = [
            RefundItem(
                product_id=ids.get("product", line["productId"]),
                name=line.get("name", ""),
                quantity=line.get("quantity", 1),
                amount=line.get("amount", 0),
            )
            for line in raw.get("lines", [])
        ]

        db.add(refund)
        added += 1

    return added


def seed_credit_notes(db: Session, ids: IdMap) -> int:
    existing = _existing_ids(db, CreditNote)
    added = 0

    for raw in load("billing/credit-notes.json"):
        new_id = ids.require("credit_note", raw["id"])
        if new_id in existing:
            continue

        db.add(
            CreditNote(
                id=new_id,
                credit_note_number=raw["creditNoteNumber"],
                invoice_id=ids.require("invoice", raw["invoiceId"]),
                invoice_number=raw.get("invoiceNumber", ""),
                order_id=ids.require("order", raw["orderId"]),
                order_number=raw.get("orderNumber", ""),
                customer_id=ids.require("customer", raw["customerId"]),
                customer_name=raw.get("customerName", ""),
                refund_id=ids.get("refund", raw.get("refundId")),
                reason=raw.get("reason", ""),
                amount=raw.get("amount", 0),
                tax=raw.get("tax", 0),
                total=raw.get("total", 0),
                issued_at=parse_dt(raw["issuedAt"]),
                status=raw.get("status", "issued"),
            )
        )
        added += 1

    return added


# ---------------------------------------------------------------------------
# the run
# ---------------------------------------------------------------------------


def seed_all() -> Dict[str, int]:
    """
    Seed everything, in dependency order.

    One transaction. A seed that committed as it went could leave orders
    referencing products that were never written, which is a database nobody
    can reason about — better to write all of it or none.
    """
    ids = build_id_map()
    counts: Dict[str, int] = {}

    with SessionLocal() as db:
        try:
            # Parents first: every later step references these.
            counts["categories"] = seed_categories(db, ids)
            counts["admin_users"] = seed_admin_users(db, ids)
            db.flush()

            counts["products"] = seed_products(db, ids)
            db.flush()

            counts["collections"] = seed_collections(db, ids)
            counts["customers"] = seed_customers(db, ids)
            db.flush()

            counts["wishlist_items"] = seed_wishlists(db, ids)
            counts["orders"] = seed_orders(db, ids)
            db.flush()

            counts["coupons"] = seed_coupons(db, ids)
            counts["reviews"] = seed_reviews(db, ids)
            counts["banners"] = seed_banners(db, ids)
            counts["homepage_sections"] = seed_homepage(db)
            counts["notifications"] = seed_notifications(db)
            counts["settings"] = seed_settings(db)

            # Billing hangs off orders, so it goes last.
            counts["invoices"] = seed_invoices(db, ids)
            db.flush()
            counts["payments"] = seed_payments(db, ids)
            db.flush()
            counts["refunds"] = seed_refunds(db, ids)
            counts["credit_notes"] = seed_credit_notes(db, ids)

            db.commit()
        except Exception:
            db.rollback()
            logger.exception("Seeding failed; nothing was written.")
            raise

    written = sum(counts.values())
    if written == 0:
        logger.info("Seed data already present; nothing to do.")
    else:
        logger.info("Seeded %d records: %s", written, _summarise(counts))

    return counts


def _summarise(counts: Dict[str, int]) -> str:
    return ", ".join(f"{name} {value}" for name, value in counts.items() if value)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    result = seed_all()
    for name, value in result.items():
        print(f"{name:20s} {value}")
