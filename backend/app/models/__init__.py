"""Every model, imported here so Alembic's autogenerate sees the full metadata.

A model that is not imported before `Base.metadata` is inspected is a model
Alembic will happily generate a DROP TABLE for.
"""

from app.models.base import BusinessId, TimestampMixin
from app.models.billing import (
    CreditNote,
    Invoice,
    InvoiceItem,
    Payment,
    PaymentEvent,
    Refund,
    RefundItem,
)
from app.models.catalogue import (
    Category,
    Collection,
    CollectionProduct,
    Product,
    ProductColor,
    ProductImage,
    ProductSize,
    ProductSpecification,
    ProductTag,
    StockAdjustment,
)
from app.models.commerce import (
    AdminUser,
    Banner,
    Coupon,
    CouponUsage,
    HomepageSection,
    Notification,
    Review,
    SettingDocument,
)
from app.models.customer import Address, CartItem, Customer, WishlistItem
from app.models.order import Order, OrderEvent, OrderItem

__all__ = [
    "BusinessId",
    "TimestampMixin",
    "Address",
    "AdminUser",
    "Banner",
    "CartItem",
    "Category",
    "Collection",
    "CollectionProduct",
    "Coupon",
    "CouponUsage",
    "CreditNote",
    "Customer",
    "HomepageSection",
    "Invoice",
    "InvoiceItem",
    "Notification",
    "Order",
    "OrderEvent",
    "OrderItem",
    "Payment",
    "PaymentEvent",
    "Product",
    "ProductColor",
    "ProductImage",
    "ProductSize",
    "ProductSpecification",
    "ProductTag",
    "Refund",
    "RefundItem",
    "Review",
    "SettingDocument",
    "StockAdjustment",
    "WishlistItem",
]
