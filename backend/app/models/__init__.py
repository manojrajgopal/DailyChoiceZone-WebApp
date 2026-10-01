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
    WebhookEvent,
    WebhookEventAttempt,
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
    "ReturnEvent",
    "ReturnRequest",
    "ReturnRequestItem",
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
    "WebhookEvent",
    "WebhookEventAttempt",
    "WishlistItem",
]
from app.models.returns import ReturnEvent, ReturnRequest, ReturnRequestItem  # noqa: E402
from app.models.membership import CustomerMembership, MembershipPlan  # noqa: E402
from app.models.commerce import CouponCustomer  # noqa: E402
from app.models.email import CustomerEmailPreference, EmailAccount, EmailLog  # noqa: E402
from app.models.accounts import CartRecovery, CustomerToken  # noqa: E402
from app.models.delivery import DeliveryPincode  # noqa: E402
from app.models.reconciliation import PaymentReconciliation, PaymentReconciliationEvent  # noqa: E402
from app.models.support import (  # noqa: E402
    CannedResponse,
    CustomerNotification,
    SupportAgent,
    SupportArticle,
    SupportCategory,
    SupportDepartment,
    SupportEmailTemplate,
    SupportRole,
    SupportTeam,
    SupportTicket,
    TicketAttachment,
    TicketEvent,
    TicketFeedback,
    TicketLink,
    TicketMessage,
)
from app.models.engagement import (  # noqa: E402
    ComparisonItem,
    PriceAlert,
    PriceAlertNotification,
    PriceChange,
    ProductAnswer,
    ProductQuestion,
    ProductQuestionEvent,
    StockAlert,
)
from app.models.wallet import (  # noqa: E402
    GiftCard,
    GiftCardTransaction,
    OrderTender,
    StoreCreditAccount,
    StoreCreditTransaction,
)
from app.models.loyalty import (  # noqa: E402
    LoyaltyAccount,
    LoyaltyLot,
    LoyaltyRedemption,
    LoyaltyTransaction,
)
from app.models.growth import (  # noqa: E402
    Bundle,
    BundleItem,
    CartBundle,
    FlashSale,
    FlashSaleClaim,
    FlashSaleItem,
    Referral,
    ReferralCode,
)
from app.models.monitoring import AnalyticsEvent, AuditLog, HealthSnapshot, JobHeartbeat  # noqa: E402
