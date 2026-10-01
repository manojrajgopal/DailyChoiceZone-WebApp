"""Stock and price alerts, product comparison, product Q&A, gift cards,
store credit and reward points

New tables:

- `stock_alerts`, `price_alerts`, `product_price_changes`,
  `price_alert_notifications` — back-in-stock and price-drop alerts, and the
  price changes that set them off.
- `comparison_items` — a signed-in customer's comparison list.
- `product_questions`, `product_answers`, `product_question_events` —
  moderated customer questions, the store's answers, and moderation history.
- `gift_cards`, `gift_card_transactions` — cards (only a keyed hash of each
  code is stored) and every movement of their balance.
- `store_credit_accounts`, `store_credit_transactions` — store credit and its
  ledger.
- `order_tenders` — what gift cards, store credit and points paid towards an
  order, and what has gone back since.
- `loyalty_accounts`, `loyalty_transactions`, `loyalty_lots`,
  `loyalty_redemptions` — reward points, as a ledger with lots.

New columns, all defaulting to zero/NULL so every existing row reads as it
did: tender amounts on `orders` and `invoices`; how a refund splits between
the gateway and tenders on `refunds`.

Safe to run again after an interruption: every table, column and index is
created only if it is missing.

Revision ID: 6d2f8b3e9a71
Revises: 3e7a9c1d5b24
Create Date: 2026-10-03 09:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "6d2f8b3e9a71"
down_revision: Union[str, None] = "3e7a9c1d5b24"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(20)
MONEY = sa.BigInteger()
NUM = sa.Numeric(12, 2)


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return _inspector().has_table(name)


def _columns(table: str) -> set:
    return {c["name"] for c in _inspector().get_columns(table)}


def _indexes(table: str) -> set:
    inspector = _inspector()
    names = {i["name"] for i in inspector.get_indexes(table)}
    names |= {u["name"] for u in inspector.get_unique_constraints(table)}
    return names


def _add_column(table: str, column: sa.Column) -> None:
    if column.name not in _columns(table):
        op.add_column(table, column)


def _create_index(name: str, table: str, columns: list, unique: bool = False) -> None:
    if name not in _indexes(table):
        op.create_index(name, table, columns, unique=unique)


def _create_table(name: str, *columns) -> None:
    if not _has_table(name):
        op.create_table(name, *columns)


def _now_columns():
    return [sa.Column("created_at", sa.DateTime(), nullable=False), sa.Column("updated_at", sa.DateTime(), nullable=False)]


def upgrade() -> None:
    # ----------------------------------------------------------- alerts
    _create_table(
        "stock_alerts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("size", sa.String(30), nullable=False, server_default=""),
        sa.Column("color", sa.String(60), nullable=False, server_default=""),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("active_key", sa.Integer(), nullable=True),
        *_now_columns(),
        sa.Column("notified_at", sa.DateTime(), nullable=True),
        sa.Column("unsubscribed_at", sa.DateTime(), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_attempt_at", sa.DateTime(), nullable=True),
        sa.Column("last_error", sa.String(300), nullable=False, server_default=""),
    )
    _create_index("ux_stock_alerts_active", "stock_alerts", ["customer_id", "product_id", "size", "color", "active_key"], unique=True)
    _create_index("ix_stock_alerts_customer_id", "stock_alerts", ["customer_id"])
    _create_index("ix_stock_alerts_product_status", "stock_alerts", ["product_id", "status"])
    _create_index("ix_stock_alerts_status_created", "stock_alerts", ["status", "created_at"])

    _create_table(
        "product_price_changes",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("old_price", MONEY, nullable=False),
        sa.Column("new_price", MONEY, nullable=False),
        sa.Column("old_original_price", MONEY, nullable=False),
        sa.Column("new_original_price", MONEY, nullable=False),
        sa.Column("changed_by", sa.String(40), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("alerts_notified", sa.Integer(), nullable=False, server_default="0"),
    )
    _create_index("ix_product_price_changes_product_id", "product_price_changes", ["product_id"])
    _create_index("ix_product_price_changes_created_at", "product_price_changes", ["created_at"])

    _create_table(
        "price_alerts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("mode", sa.String(10), nullable=False),
        sa.Column("baseline_price", MONEY, nullable=False),
        sa.Column("target_price", MONEY, nullable=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("active_key", sa.Integer(), nullable=True),
        *_now_columns(),
        sa.Column("notified_at", sa.DateTime(), nullable=True),
        sa.Column("notified_price", MONEY, nullable=True),
        sa.Column("unsubscribed_at", sa.DateTime(), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_attempt_at", sa.DateTime(), nullable=True),
        sa.Column("last_error", sa.String(300), nullable=False, server_default=""),
    )
    _create_index("ux_price_alerts_active", "price_alerts", ["customer_id", "product_id", "active_key"], unique=True)
    _create_index("ix_price_alerts_customer_id", "price_alerts", ["customer_id"])
    _create_index("ix_price_alerts_product_status", "price_alerts", ["product_id", "status"])
    _create_index("ix_price_alerts_status_created", "price_alerts", ["status", "created_at"])

    _create_table(
        "price_alert_notifications",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("alert_id", sa.Integer(), sa.ForeignKey("price_alerts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("price_change_id", sa.Integer(), sa.ForeignKey("product_price_changes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("from_price", MONEY, nullable=False),
        sa.Column("to_price", MONEY, nullable=False),
        sa.Column("outcome", sa.String(20), nullable=False),
        sa.Column("note", sa.String(300), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_index("ux_price_alert_notification", "price_alert_notifications", ["alert_id", "price_change_id"], unique=True)

    # -------------------------------------------------------- comparison
    _create_table(
        "comparison_items",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_index("ux_comparison_product", "comparison_items", ["customer_id", "product_id"], unique=True)
    _create_index("ix_comparison_items_customer_id", "comparison_items", ["customer_id"])

    # ---------------------------------------------------------------- Q&A
    _create_table(
        "product_questions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("author_name", sa.String(80), nullable=False),
        sa.Column("size", sa.String(30), nullable=False, server_default=""),
        sa.Column("color", sa.String(60), nullable=False, server_default=""),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("body_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("rejection_reason", sa.String(300), nullable=False, server_default=""),
        *_now_columns(),
        sa.Column("moderated_at", sa.DateTime(), nullable=True),
        sa.Column("moderated_by", ID, nullable=True),
    )
    _create_index("ix_product_questions_product_status", "product_questions", ["product_id", "status", "created_at"])
    _create_index("ix_product_questions_status_created", "product_questions", ["status", "created_at"])
    _create_index("ix_product_questions_duplicate", "product_questions", ["customer_id", "product_id", "body_hash"])

    _create_table(
        "product_answers",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("question_id", sa.Integer(), sa.ForeignKey("product_questions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("published", sa.Boolean(), nullable=False),
        sa.Column("admin_id", ID, nullable=True),
        sa.Column("admin_name", sa.String(120), nullable=False),
        *_now_columns(),
        sa.Column("published_at", sa.DateTime(), nullable=True),
    )
    _create_index("ux_product_answers_question", "product_answers", ["question_id"], unique=True)

    _create_table(
        "product_question_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("question_id", sa.Integer(), sa.ForeignKey("product_questions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("action", sa.String(30), nullable=False),
        sa.Column("note", sa.String(500), nullable=False, server_default=""),
        sa.Column("admin_id", ID, nullable=True),
        sa.Column("admin_name", sa.String(120), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_index("ix_product_question_events_question_id", "product_question_events", ["question_id"])

    # --------------------------------------------------------- gift cards
    _create_table(
        "gift_cards",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("code_last4", sa.String(4), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("initial_amount", MONEY, nullable=False),
        sa.Column("balance", MONEY, nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("source", sa.String(20), nullable=False),
        sa.Column("purchaser_id", ID, sa.ForeignKey("customers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("sender_name", sa.String(120), nullable=False),
        sa.Column("recipient_name", sa.String(120), nullable=False),
        sa.Column("recipient_email", sa.String(255), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("delivered_at", sa.DateTime(), nullable=True),
        sa.Column("activated_at", sa.DateTime(), nullable=True),
        sa.Column("gateway_order_id", sa.String(60), nullable=True),
        sa.Column("gateway_payment_id", sa.String(60), nullable=True),
        sa.Column("paid_at", sa.DateTime(), nullable=True),
        sa.Column("issued_by", ID, nullable=True),
        sa.Column("status_reason", sa.String(300), nullable=False),
        *_now_columns(),
    )
    _create_index("ux_gift_cards_code_hash", "gift_cards", ["code_hash"], unique=True)
    _create_index("ix_gift_cards_status_created", "gift_cards", ["status", "created_at"])
    _create_index("ix_gift_cards_recipient_email", "gift_cards", ["recipient_email"])
    _create_index("ix_gift_cards_purchaser_id", "gift_cards", ["purchaser_id"])
    _create_index("ix_gift_cards_gateway_order_id", "gift_cards", ["gateway_order_id"])

    _create_table(
        "gift_card_transactions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("gift_card_id", sa.Integer(), sa.ForeignKey("gift_cards.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("amount", MONEY, nullable=False),
        sa.Column("balance_after", MONEY, nullable=False),
        sa.Column("order_id", ID, sa.ForeignKey("orders.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("refund_id", ID, nullable=True),
        sa.Column("note", sa.String(300), nullable=False),
        sa.Column("admin_id", ID, nullable=True),
        sa.Column("idempotency_key", sa.String(80), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_index("ux_gift_card_txn_key", "gift_card_transactions", ["idempotency_key"], unique=True)
    _create_index("ix_gift_card_transactions_gift_card_id", "gift_card_transactions", ["gift_card_id"])
    _create_index("ix_gift_card_transactions_order_id", "gift_card_transactions", ["order_id"])

    # ------------------------------------------------------- store credit
    _create_table(
        "store_credit_accounts",
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("balance", MONEY, nullable=False),
        sa.Column("lifetime_credited", MONEY, nullable=False),
        sa.Column("lifetime_spent", MONEY, nullable=False),
        *_now_columns(),
    )
    _create_table(
        "store_credit_transactions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("amount", MONEY, nullable=False),
        sa.Column("balance_after", MONEY, nullable=False),
        sa.Column("reason", sa.String(300), nullable=False),
        sa.Column("order_id", ID, sa.ForeignKey("orders.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("refund_id", ID, nullable=True),
        sa.Column("admin_id", ID, nullable=True),
        sa.Column("admin_name", sa.String(120), nullable=False),
        sa.Column("idempotency_key", sa.String(80), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_index("ux_store_credit_txn_key", "store_credit_transactions", ["idempotency_key"], unique=True)
    _create_index("ix_store_credit_txn_customer_created", "store_credit_transactions", ["customer_id", "created_at"])
    _create_index("ix_store_credit_transactions_order_id", "store_credit_transactions", ["order_id"])

    # ------------------------------------------------------------ tenders
    _create_table(
        "order_tenders",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("order_id", ID, sa.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("tender_key", sa.String(40), nullable=False),
        sa.Column("gift_card_id", sa.Integer(), sa.ForeignKey("gift_cards.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("amount", MONEY, nullable=False),
        sa.Column("points", sa.Integer(), nullable=False),
        sa.Column("reversed_amount", MONEY, nullable=False),
        sa.Column("reversed_points", sa.Integer(), nullable=False),
        *_now_columns(),
    )
    _create_index("ux_order_tender", "order_tenders", ["order_id", "tender_key"], unique=True)
    _create_index("ix_order_tenders_order_id", "order_tenders", ["order_id"])
    _create_index("ix_order_tenders_gift_card_id", "order_tenders", ["gift_card_id"])

    # ------------------------------------------------------------ loyalty
    _create_table(
        "loyalty_accounts",
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("debt", sa.Integer(), nullable=False),
        sa.Column("lifetime_earned", sa.Integer(), nullable=False),
        sa.Column("lifetime_redeemed", sa.Integer(), nullable=False),
        sa.Column("lifetime_expired", sa.Integer(), nullable=False),
        sa.Column("lifetime_reversed", sa.Integer(), nullable=False),
        *_now_columns(),
    )
    _create_table(
        "loyalty_transactions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("points", sa.Integer(), nullable=False),
        sa.Column("balance_after", sa.Integer(), nullable=False),
        sa.Column("order_id", ID, sa.ForeignKey("orders.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("refund_id", ID, nullable=True),
        sa.Column("reason", sa.String(300), nullable=False),
        sa.Column("available_at", sa.DateTime(), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("admin_id", ID, nullable=True),
        sa.Column("admin_name", sa.String(120), nullable=False),
        sa.Column("idempotency_key", sa.String(80), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_index("ux_loyalty_txn_key", "loyalty_transactions", ["idempotency_key"], unique=True)
    _create_index("ix_loyalty_txn_customer_created", "loyalty_transactions", ["customer_id", "created_at"])
    _create_index("ix_loyalty_txn_kind_created", "loyalty_transactions", ["kind", "created_at"])
    _create_index("ix_loyalty_transactions_order_id", "loyalty_transactions", ["order_id"])

    _create_table(
        "loyalty_lots",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("transaction_id", sa.Integer(), sa.ForeignKey("loyalty_transactions.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("order_id", ID, nullable=True),
        sa.Column("points", sa.Integer(), nullable=False),
        sa.Column("remaining", sa.Integer(), nullable=False),
        sa.Column("available_at", sa.DateTime(), nullable=False),
        sa.Column("released", sa.Boolean(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("expiry_warned_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_index("ix_loyalty_lots_customer_expiry", "loyalty_lots", ["customer_id", "expires_at"])
    _create_index("ix_loyalty_lots_release", "loyalty_lots", ["released", "available_at"])
    _create_index("ix_loyalty_lots_transaction_id", "loyalty_lots", ["transaction_id"])
    _create_index("ix_loyalty_lots_order_id", "loyalty_lots", ["order_id"])

    _create_table(
        "loyalty_redemptions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("order_id", ID, sa.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("lot_id", sa.Integer(), sa.ForeignKey("loyalty_lots.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("points", sa.Integer(), nullable=False),
        sa.Column("restored", sa.Integer(), nullable=False),
    )
    _create_index("ix_loyalty_redemptions_order_id", "loyalty_redemptions", ["order_id"])

    # ---------------------------------------------- tender columns on records
    for name in ("gift_card_amount", "store_credit_amount", "points_amount"):
        _add_column("orders", sa.Column(name, NUM, nullable=False, server_default="0"))
        _add_column("invoices", sa.Column(name, MONEY, nullable=False, server_default="0"))
    _add_column("orders", sa.Column("points_redeemed", sa.Integer(), nullable=False, server_default="0"))
    _add_column("invoices", sa.Column("points_redeemed", sa.Integer(), nullable=False, server_default="0"))
    _add_column("refunds", sa.Column("gateway_amount", MONEY, nullable=True))
    _add_column("refunds", sa.Column("tender_amount", MONEY, nullable=False, server_default="0"))


def downgrade() -> None:
    for table in ("refunds",):
        for name in ("gateway_amount", "tender_amount"):
            if name in _columns(table):
                op.drop_column(table, name)
    for table in ("orders", "invoices"):
        for name in ("gift_card_amount", "store_credit_amount", "points_amount", "points_redeemed"):
            if name in _columns(table):
                op.drop_column(table, name)
    for name in (
        "loyalty_redemptions", "loyalty_lots", "loyalty_transactions", "loyalty_accounts",
        "order_tenders", "store_credit_transactions", "store_credit_accounts",
        "gift_card_transactions", "gift_cards",
        "product_question_events", "product_answers", "product_questions",
        "comparison_items", "price_alert_notifications", "price_alerts", "product_price_changes", "stock_alerts",
    ):
        if _has_table(name):
            op.drop_table(name)
