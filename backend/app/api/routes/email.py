"""
Email: the store's settings, customers' choices, and the Google sign-in hop.

Store (permission "settings"):
    GET    /api/admin/email                 the account (secrets masked), types
    POST   /api/admin/email/account         test with these details; save if sent
    POST   /api/admin/email/test            test the saved account
    DELETE /api/admin/email/account         stop sending
    PUT    /api/admin/email/types           which emails go out, which customers may refuse
    GET    /api/admin/email/log             recent sends
    POST   /api/admin/email/google/start    begin "Connect with Google"
    POST   /api/admin/billing/invoices/{id}/send   email an invoice to its customer

Customers:
    GET/PUT /api/account/email-preferences

Google redirects to  GET /auth/callback  (outside /api — the address the
OAuth client is registered with). It is worked out from the running API, never
typed into the portal.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Dict, List

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import RedirectResponse
from jose import JWTError, jwt
from pydantic import Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.errors import NotFoundError, ValidationError
from app.dependencies.auth import get_current_customer, require_permission
from app.models import AdminUser, Customer, Invoice
from app.schemas.base import CamelModel
from app.services import email as service
from app.services.email import crypto
from app.services.email.senders import SendError, consent_url, exchange_code
from app.utils.response import Pagination, ok

admin_router = APIRouter(prefix="/admin/email", tags=["Admin · Email"])
invoice_router = APIRouter(prefix="/admin/billing", tags=["Admin · Email"])
account_router = APIRouter(prefix="/account", tags=["Customers"])
callback_router = APIRouter(tags=["Email"])

STATE_MINUTES = 15


def redirect_uri(request: Request) -> str:
    """Where Google sends the admin back: this API's own /auth/callback."""
    base = (getattr(settings, "PUBLIC_API_URL", "") or str(request.base_url)).rstrip("/")
    return f"{base}/auth/callback"


class AccountIn(CamelModel):
    provider: str = Field(max_length=20)
    sender_email: str = Field(max_length=255)
    sender_name: str = Field(default="", max_length=120)
    reply_to: str = Field(default="", max_length=255)
    test_recipient: str = Field(default="", max_length=255)
    # gmail-oauth
    client_id: str = Field(default="", max_length=300)
    client_secret: str = Field(default="", max_length=300)
    refresh_token: str = Field(default="", max_length=2000)
    access_token: str = Field(default="", max_length=4000)
    # smtp
    host: str = Field(default="", max_length=255)
    port: str = Field(default="", max_length=6)
    security: str = Field(default="", max_length=10)
    username: str = Field(default="", max_length=255)
    password: str = Field(default="", max_length=500)


class TestIn(CamelModel):
    recipient: str = Field(max_length=255)


class TypeIn(CamelModel):
    key: str
    enabled: bool
    customer_can_opt_out: bool


class GoogleStartIn(CamelModel):
    client_id: str = Field(max_length=300)
    client_secret: str = Field(default="", max_length=300)
    sender_email: str = Field(max_length=255)
    sender_name: str = Field(default="", max_length=120)
    reply_to: str = Field(default="", max_length=255)
    test_recipient: str = Field(default="", max_length=255)


def _account_payload(body: AccountIn) -> dict:
    data = body.model_dump(by_alias=True)
    data.pop("testRecipient", None)
    return data


# ------------------------------------------------------------------- store


@admin_router.get("", summary="Email settings")
def get_settings(request: Request, db: Session = Depends(get_db), admin: AdminUser = Depends(require_permission("settings"))):
    return ok({"account": service.account_view(db, redirect_uri(request)), "types": service.types(db)})


@admin_router.post("/account", summary="Test these details, and save them if the test arrives")
def save_account(
    body: AccountIn,
    request: Request,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("settings")),
):
    result = service.test_and_save(db, _account_payload(body), actor=admin.id, test_recipient=body.test_recipient)
    return ok(
        {"account": service.account_view(db, redirect_uri(request)), **result},
        message=f"Test email sent to {result['sentTo']}. Your email settings are saved.",
    )


@admin_router.post("/test", summary="Send a test with the saved account")
def test_account(body: TestIn, db: Session = Depends(get_db), admin: AdminUser = Depends(require_permission("settings"))):
    service.send_test(db, body.recipient)
    return ok(message=f"Test email sent to {body.recipient}.")


@admin_router.delete("/account", summary="Stop sending email")
def disconnect(db: Session = Depends(get_db), admin: AdminUser = Depends(require_permission("settings"))):
    service.disconnect(db)
    return ok(message="Email sending is turned off.")


@admin_router.put("/types", summary="Which emails are sent")
def save_types(body: List[TypeIn], db: Session = Depends(get_db), admin: AdminUser = Depends(require_permission("settings"))):
    return ok(service.save_types(db, [t.model_dump(by_alias=True) for t in body]), message="Email preferences saved.")


def _log_row(row) -> dict:
    return {
        "id": row.id, "type": row.email_type, "recipient": row.recipient, "subject": row.subject,
        "status": row.status, "error": row.error, "reference": row.reference, "at": row.created_at,
        "bouncedAt": row.bounced_at,
    }


@admin_router.get("/log", summary="Recent emails")
def log(
    limit: int = Query(100, ge=1, le=100),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("settings")),
):
    return ok([_log_row(row) for row in service.recent_log(db, limit)])


@admin_router.get("/log/search", summary="The full email log, filtered and paged")
def log_search(
    status: str = Query("", max_length=12),
    type: str = Query("", max_length=40),
    q: str = Query("", max_length=120),
    date_from: str = Query("", alias="from", max_length=30),
    date_to: str = Query("", alias="to", max_length=30),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("settings")),
):
    from app.utils.dates import parse_dt

    rows, total, counts = service.search_log(
        db, status=status, email_type=type, query=q,
        date_from=parse_dt(date_from) if date_from else None,
        date_to=parse_dt(date_to) if date_to else None,
        page=page, page_size=page_size,
    )
    return ok({
        "items": [_log_row(row) for row in rows],
        "pagination": Pagination.build(page, page_size, total).model_dump(),
        "counts": {"sent": counts.get("sent", 0), "failed": counts.get("failed", 0)},
        "types": [{"key": t["key"], "label": t["label"]} for t in service.types(db)],
    })


@admin_router.post("/google/start", summary="Begin connecting a Google account")
def google_start(
    body: GoogleStartIn,
    request: Request,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("settings")),
):
    # A blank secret keeps the saved one, as the form does elsewhere.
    secret = body.client_secret
    if not secret:
        account = service.active_account(db)
        if account and account.provider == "gmail-oauth":
            secret = crypto.unseal(account.credentials).get("clientSecret", "")
    if not (body.client_id and secret):
        raise ValidationError("Enter the client ID and client secret first.", error_code="GOOGLE_INCOMPLETE")

    # Everything the callback needs rides in a signed, encrypted, short-lived
    # state token — nothing is stored until the test email has been sent.
    pending = crypto.seal({
        "clientId": body.client_id, "clientSecret": secret, "senderEmail": body.sender_email,
        "senderName": body.sender_name, "replyTo": body.reply_to,
        "testRecipient": body.test_recipient or body.sender_email, "admin": admin.id,
    })
    state = jwt.encode(
        {"p": pending, "exp": datetime.utcnow() + timedelta(minutes=STATE_MINUTES), "purpose": "email-oauth"},
        settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM,
    )
    uri = redirect_uri(request)
    return ok({
        "authorizationUrl": consent_url(client_id=body.client_id, redirect_uri=uri, state=state, login_hint=body.sender_email),
        "redirectUri": uri,
    })


@invoice_router.post("/invoices/{invoice_id}/send", summary="Email an invoice to its customer")
def send_invoice(invoice_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(require_permission("orders"))):
    from app.services.email.notifications import notify_invoice

    invoice = db.get(Invoice, invoice_id)
    if invoice is None:
        raise NotFoundError("We couldn't find that invoice.", error_code="INVOICE_NOT_FOUND")
    if service.active_account(db) is None:
        raise ValidationError("Set up email in Settings → Email to send invoices.", error_code="EMAIL_NOT_CONFIGURED")
    if not notify_invoice(db, invoice):
        raise ValidationError(
            "Invoice emails are switched off, or this customer has turned them off.", error_code="EMAIL_NOT_SENT"
        )
    db.commit()  # the email leaves once this commits
    return ok(message=f"Invoice sent to {invoice.customer_email}.")


# --------------------------------------------------------------- customers


@account_router.get("/email-preferences", summary="Your email preferences")
def my_preferences(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(service.preferences(db, customer.id))


@account_router.put("/email-preferences", summary="Update your email preferences")
def update_preferences(
    body: Dict[str, bool],
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    return ok(service.save_preferences(db, customer.id, body), message="Your email preferences are saved.")


# ---------------------------------------------------------- Google's return


@callback_router.get("/auth/callback", include_in_schema=False)
def google_callback(request: Request, code: str = "", state: str = "", error: str = "", db: Session = Depends(get_db)):
    portal = f"{settings.STOREFRONT_URL.rstrip('/')}/admin/settings/email"

    def back(outcome: str, message: str = "") -> RedirectResponse:
        from urllib.parse import urlencode

        return RedirectResponse(f"{portal}?{urlencode({'google': outcome, 'message': message[:300]})}", status_code=303)

    if error:
        return back("cancelled", "Google sign-in was cancelled.")
    try:
        claims = jwt.decode(state, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    except JWTError:
        return back("failed", "The connection request expired. Please try again.")
    if claims.get("purpose") != "email-oauth":
        return back("failed", "That connection request isn't valid.")
    pending = crypto.unseal(claims.get("p", ""))
    if not pending or not code:
        return back("failed", "That connection request isn't valid.")

    try:
        tokens = exchange_code(
            client_id=pending["clientId"], client_secret=pending["clientSecret"],
            code=code, redirect_uri=redirect_uri(request),
        )
        service.test_and_save(
            db,
            {
                "provider": "gmail-oauth", "senderEmail": pending["senderEmail"],
                "senderName": pending.get("senderName", ""), "replyTo": pending.get("replyTo", ""),
                "clientId": pending["clientId"], "clientSecret": pending["clientSecret"],
                "refreshToken": tokens["refreshToken"], "accessToken": tokens.get("accessToken", ""),
            },
            actor=pending.get("admin") or "admin",
            test_recipient=pending.get("testRecipient", ""),
        )
    except (SendError, ValidationError) as failure:
        return back("failed", str(failure))
    return back("connected", f"Google account connected. A test email was sent to {pending.get('testRecipient')}.")
