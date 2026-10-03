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
from app.models.messaging import (  # noqa: E402
    CampaignRecipient,
    ChannelPreference,
    DatabaseBackup,
    MarketingCampaign,
    NotificationDelivery,
    NotificationTemplate,
    ReorderEvent,
)
from app.models.shipping import Shipment, ShipmentEvent, ShippingProvider, ShippingWebhookEvent  # noqa: E402
# Packing and shipping labels (docs/packing-and-labels.md).
from app.models.fulfilment import (  # noqa: E402
    PackingEvent,
    PackingJob,
    PackingLine,
    PackingPackage,
    PackingPackageItem,
    ShippingLabel,
)
from app.models.suppliers import (  # noqa: E402
    GoodsReceipt,
    GoodsReceiptItem,
    PurchaseOrder,
    PurchaseOrderEvent,
    PurchaseOrderItem,
    Supplier,
    SupplierProduct,
)
# Search & filters: attributes, the search index and dictionary, the search log (docs/search-and-filters.md).
from app.models.search import (  # noqa: E402
    ProductAttribute,
    ProductAttributeOption,
    ProductAttributeValue,
    ProductSearchIndex,
    SearchClick,
    SearchDailyStat,
    SearchQuery,
    SearchTerm,
)
# Customer sign-in: linked providers, one-time codes, OAuth trips, sessions.
from app.models.identity import CustomerIdentity, CustomerSession, OAuthState, OtpChallenge  # noqa: E402
# Product discovery: recently viewed, saved for later, relationships, size
# guides, per-product delivery rules (docs/product-discovery.md).
from app.models.discovery import (  # noqa: E402
    ProductDeliveryExclusion,
    ProductDeliveryProfile,
    ProductRelationship,
    ProductSizeGuide,
    RecentlyViewedProduct,
    SavedCartItem,
    SizeGuide,
    SizeGuideCategory,
)
# Customer segmentation: per-customer metrics, segments, members, history (docs/customer-segmentation.md).
from app.models.segments import CustomerMetrics, Segment, SegmentEvent, SegmentMember  # noqa: E402
