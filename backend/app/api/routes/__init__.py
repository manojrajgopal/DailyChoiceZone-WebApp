"""Every router the application exposes, in one list.

Registered here rather than scattered through `main`, so adding an endpoint
group is one import and one entry — and so the full API surface is readable in
a single file.
"""

from app.api.routes import (
    auth,
    billing,
    cart,
    catalogue,
    coupons,
    orders,
    products,
    reports,
    reviews,
    site,
    wishlist,
)
from app.api.routes.admin import (
    catalogue as admin_catalogue,
    content as admin_content,
    customers as admin_customers,
    dashboard as admin_dashboard,
    orders as admin_orders,
    settings as admin_settings,
)

all_routers = [
    # --- storefront ------------------------------------------------------
    auth.router,
    auth.account_router,
    products.router,
    catalogue.router,
    catalogue.collections_router,
    reviews.router,
    coupons.router,
    cart.router,
    wishlist.router,
    orders.router,
    billing.router,
    site.router,
    # --- portal ----------------------------------------------------------
    auth.admin_auth_router,
    products.admin_router,
    admin_catalogue.router,
    admin_catalogue.inventory_router,
    admin_orders.router,
    admin_customers.router,
    admin_content.router,
    admin_content.marketing_router,
    admin_settings.router,
    admin_dashboard.router,
    reports.router,
    billing.admin_router,
]
