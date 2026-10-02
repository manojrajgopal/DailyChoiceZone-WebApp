"""
Notifications, campaigns, backups and reorder.

The portal's endpoints check their permission here, on the server —
`notifications`, `campaigns`, `backups`. Customers reach only their own
preferences and their own orders. Provider webhooks are verified by
signature before anything is read from them.
"""

from __future__ import annotations

from datetime import timedelta
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.config import settings
from app.core.errors import NotFoundError, ValidationError
from app.core.database import get_db
from app.dependencies.auth import client_ip, get_current_customer, require_access
from app.models import (
    AdminUser,
    CampaignRecipient,
    Category,
    Customer,
    MembershipPlan,
    NotificationDelivery,
)
from app.schemas.base import CamelModel
from app.services import backups, reorder
from app.services.messaging import campaigns, catalogue, service as messaging
from app.utils.dates import parse_dt
from app.utils.response import Pagination, ok

account_router = APIRouter(prefix="/account", tags=["Account · Notifications"])
public_router = APIRouter(tags=["Notifications"])
reorder_router = APIRouter(prefix="/orders", tags=["Orders"])
# Not /admin/notifications: that is the admin tray's (routes/admin/settings.py).
admin_notifications_router = APIRouter(prefix="/admin/messaging", tags=["Admin · Notifications"])
admin_campaigns_router = APIRouter(prefix="/admin/campaigns", tags=["Admin · Campaigns"])
admin_backups_router = APIRouter(prefix="/admin/backups", tags=["Admin · Backups"])

PIXEL = (b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,"
         b"\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")


def _page(page: int, size: int, total: int) -> dict:
    return Pagination.build(page, size, total).model_dump()


# --------------------------------------------------------------- customers


class PreferenceIn(CamelModel):
    channel: str = Field(max_length=12)
    category: str = Field(max_length=15)
    enabled: bool


@account_router.get("/notification-preferences", summary="Your SMS, WhatsApp and marketing choices")
def my_channel_preferences(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(messaging.preferences(db, customer))


@account_router.put("/notification-preferences", summary="Change your SMS, WhatsApp and marketing choices")
def save_channel_preferences(body: List[PreferenceIn], db: Session = Depends(get_db),
                             customer: Customer = Depends(get_current_customer)):
    return ok(messaging.save_preferences(db, customer, [b.model_dump() for b in body]), message="Preferences saved.")


class ReorderIn(CamelModel):
    # Lines from GET /orders/{id}/reorder. Omitted: everything that can be added.
    keys: Optional[List[str]] = Field(default=None, max_length=100)


@reorder_router.get("/{order_id}/reorder", summary="What from this order can go back in your bag")
def reorderable(order_id: str, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(reorder.reorderable(db, customer, order_id))


@reorder_router.post("/{order_id}/reorder", summary="Put this order's items back in your bag, at today's prices")
def reorder_items(order_id: str, body: ReorderIn, db: Session = Depends(get_db),
                  customer: Customer = Depends(get_current_customer)):
    rate_limit.check(f"reorder:{customer.id}", limit=20, window_seconds=60)
    result = reorder.reorder(db, customer, order_id, body.keys)
    return ok(result, message=result["message"])


# ------------------------------------------------------------------ public


class TokenIn(CamelModel):
    token: str = Field(min_length=10, max_length=300)


@public_router.post("/notifications/unsubscribe", summary="Stop marketing on one channel, from a link")
def unsubscribe(body: TokenIn, request: Request, db: Session = Depends(get_db)):
    rate_limit.check(f"unsubscribe:{client_ip(request)}", limit=30, window_seconds=300)
    return ok(messaging.unsubscribe(db, body.token), message="You've been unsubscribed.")


@public_router.get("/c/o/{token}.gif", include_in_schema=False)
def open_pixel(token: str, db: Session = Depends(get_db)):
    if len(token) == 32:
        try:
            campaigns.record_open(db, token)
        except Exception:  # noqa: BLE001 — a tracking image must always load
            db.rollback()
    return Response(PIXEL, media_type="image/gif", headers={"Cache-Control": "no-store, max-age=0"})


class ClickIn(CamelModel):
    token: str = Field(min_length=4, max_length=40)
    to: str = Field(min_length=1, max_length=1000)
    s: str = Field(min_length=1, max_length=64)


@public_router.post("/campaigns/click", summary="Record a campaign link click and say where it goes")
def campaign_click(body: ClickIn, request: Request, db: Session = Depends(get_db)):
    rate_limit.check(f"click:{client_ip(request)}", limit=60, window_seconds=60)
    destination = campaigns.record_click(db, body.token, body.to, body.s)
    if destination is None:
        raise ValidationError("This link isn't valid.", error_code="LINK_INVALID")
    return ok({"url": destination})


@public_router.post("/notifications/webhooks/twilio", include_in_schema=False)
async def twilio_webhook(request: Request, db: Session = Depends(get_db)):
    form = {k: str(v) for k, v in (await request.form()).items()}
    url = messaging.providers.status_callback_url("twilio") or str(request.url)
    if not messaging.twilio_signature_valid(url, form, request.headers.get("X-Twilio-Signature", "")):
        return PlainTextResponse("signature", status_code=403)
    messaging.twilio_status(db, form)
    return PlainTextResponse("ok")


@public_router.get("/notifications/webhooks/whatsapp", include_in_schema=False)
def whatsapp_verify(request: Request):
    params = request.query_params
    if (settings.WHATSAPP_VERIFY_TOKEN and params.get("hub.mode") == "subscribe"
            and params.get("hub.verify_token") == settings.WHATSAPP_VERIFY_TOKEN):
        return PlainTextResponse(params.get("hub.challenge", ""))
    return PlainTextResponse("forbidden", status_code=403)


@public_router.post("/notifications/webhooks/whatsapp", include_in_schema=False)
async def whatsapp_webhook(request: Request, db: Session = Depends(get_db)):
    body = await request.body()
    if not messaging.whatsapp_signature_valid(body, request.headers.get("X-Hub-Signature-256", "")):
        return PlainTextResponse("signature", status_code=403)
    import json

    try:
        payload = json.loads(body or b"{}")
    except ValueError:
        return PlainTextResponse("bad request", status_code=400)
    messaging.whatsapp_event(db, payload)
    return PlainTextResponse("ok")


# ------------------------------------------------------------ notifications

NOTIFY = require_access("notifications")


@admin_notifications_router.get("", summary="Every message on every channel")
def admin_notifications(channel: str = Query("", max_length=12), status: str = Query("", max_length=12),
                        event: str = Query("", max_length=60), customer: str = Query("", max_length=20),
                        q: str = Query("", max_length=100), date_from: Optional[str] = Query(None, alias="from"),
                        date_to: Optional[str] = Query(None, alias="to"), page: int = Query(1, ge=1),
                        page_size: int = Query(25, ge=1, le=100, alias="pageSize"), db: Session = Depends(get_db),
                        admin: AdminUser = Depends(NOTIFY)):
    start, end = parse_dt(date_from), parse_dt(date_to)
    if end and date_to and len(date_to) == 10:
        end = end + timedelta(days=1)
    items, total, counts = messaging.search(db, channel=channel, status=status, event=event, customer=customer, q=q,
                                            date_from=start, date_to=end, page=page, page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total), "counts": counts})


@admin_notifications_router.get("/overview", summary="Channels, their setup, and the last week")
def admin_notifications_overview(days: int = Query(7, ge=1, le=90), db: Session = Depends(get_db),
                                 admin: AdminUser = Depends(NOTIFY)):
    return ok({**messaging.overview(db, days=days),
               "events": [{"key": k, "label": v["label"], "group": v["group"], "category": v["category"]}
                          for k, v in catalogue.EVENTS.items()]})


@admin_notifications_router.put("/channels", summary="Which events send SMS and WhatsApp")
def admin_save_channels(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(NOTIFY)):
    return ok(messaging.save_routing(db, admin, payload), message="Channels saved.")


@admin_notifications_router.get("/templates", summary="Every notification's wording")
def admin_templates(db: Session = Depends(get_db), admin: AdminUser = Depends(NOTIFY)):
    return ok(messaging.list_templates(db))


@admin_notifications_router.get("/templates/{key}", summary="One notification's wording")
def admin_template(key: str, db: Session = Depends(get_db), admin: AdminUser = Depends(NOTIFY)):
    return ok(messaging.template_view(db, key))


@admin_notifications_router.put("/templates/{key}", summary="Save a notification's wording")
def admin_save_template(key: str, payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(NOTIFY)):
    return ok(messaging.save_template(db, admin, key, payload), message="Template saved.")


@admin_notifications_router.post("/templates/{key}/reset", summary="Go back to the built-in wording")
def admin_reset_template(key: str, db: Session = Depends(get_db), admin: AdminUser = Depends(NOTIFY)):
    return ok(messaging.reset_template(db, admin, key), message="Back to the built-in wording.")


@admin_notifications_router.post("/templates/{key}/preview", summary="Preview a notification on every channel")
def admin_preview_template(key: str, payload: Optional[dict] = None, db: Session = Depends(get_db),
                           admin: AdminUser = Depends(NOTIFY)):
    messaging.effective(db, key)
    return ok(messaging.preview(db, key, payload or None))


class TestIn(CamelModel):
    channel: str = Field(max_length=12)
    recipient: str = Field(min_length=3, max_length=255)


@admin_notifications_router.post("/templates/{key}/test", summary="Send a test to yourself")
def admin_test_template(key: str, body: TestIn, db: Session = Depends(get_db), admin: AdminUser = Depends(NOTIFY)):
    rate_limit.check(f"notify-test:{admin.id}", limit=10, window_seconds=300)
    messaging.effective(db, key)
    return ok(messaging.send_test(db, admin, key, body.channel, body.recipient), message="Test sent.")


@admin_notifications_router.get("/{delivery_id}", summary="One message, with its content")
def admin_notification(delivery_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(NOTIFY)):
    row = db.get(NotificationDelivery, delivery_id)
    if row is None:
        raise NotFoundError("No such notification.", error_code="NOTIFICATION_NOT_FOUND")
    person = db.get(Customer, row.customer_id) if row.customer_id else None
    return ok(messaging.view(row, customer=person, full=True))


@admin_notifications_router.post("/{delivery_id}/retry", summary="Send a failed message again")
def admin_retry(delivery_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(NOTIFY)):
    row = messaging.retry(db, admin, delivery_id)
    person = db.get(Customer, row.customer_id) if row.customer_id else None
    return ok(messaging.view(row, customer=person), message="Sent again." if row.status == "sent" else "Queued again.")


# ---------------------------------------------------------------- campaigns

CAMPAIGNS = require_access("campaigns")


@admin_campaigns_router.get("", summary="Campaigns")
def admin_campaigns(status: str = Query("", max_length=12), q: str = Query("", max_length=100),
                    page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
                    db: Session = Depends(get_db), admin: AdminUser = Depends(CAMPAIGNS)):
    items, total, counts = campaigns.admin_list(db, status=status, q=q, page=page, page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total), "counts": counts})


@admin_campaigns_router.get("/options", summary="Types, segments, variables and what filters can name")
def admin_campaign_options(db: Session = Depends(get_db), admin: AdminUser = Depends(CAMPAIGNS)):
    return ok({
        "kinds": [{"value": k, "label": v} for k, v in campaigns.KINDS.items()],
        "segments": list(campaigns.SEGMENTS), "variables": campaigns.VARIABLES,
        "starters": {k: {"heading": h, "message": m} for k, (h, m) in campaigns.STARTERS.items()},
        "channels": messaging.channel_status(db),
        "plans": [{"id": p.id, "name": p.name} for p in db.execute(select(MembershipPlan)).scalars()],
        "categories": [{"id": c.id, "name": c.name} for c in db.execute(select(Category).order_by(Category.name)).scalars()],
        "openTracking": bool(campaigns.tracking_base()),
    })


class EstimateIn(CamelModel):
    audience: dict = Field(default_factory=dict)
    channels: List[str] = Field(default_factory=list, max_length=4)


@admin_campaigns_router.post("/estimate", summary="How many customers and messages an audience means")
def admin_estimate(body: EstimateIn, db: Session = Depends(get_db), admin: AdminUser = Depends(CAMPAIGNS)):
    return ok(campaigns.estimate(db, body.audience, body.channels))


@admin_campaigns_router.post("", status_code=201, summary="Create a campaign (as a draft)")
def admin_create_campaign(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(CAMPAIGNS)):
    row = campaigns.save(db, admin, payload)
    return ok(campaigns.view(db, row, full=True), message="Campaign saved as a draft.")


@admin_campaigns_router.get("/{campaign_id}", summary="One campaign, with its results")
def admin_campaign(campaign_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(CAMPAIGNS)):
    return ok(campaigns.view(db, campaigns._load(db, campaign_id), full=True))


@admin_campaigns_router.put("/{campaign_id}", summary="Change a draft campaign")
def admin_update_campaign(campaign_id: int, payload: dict, db: Session = Depends(get_db),
                          admin: AdminUser = Depends(CAMPAIGNS)):
    row = campaigns.save(db, admin, payload, campaign_id)
    return ok(campaigns.view(db, row, full=True), message="Campaign saved.")


@admin_campaigns_router.delete("/{campaign_id}", summary="Delete a draft campaign")
def admin_delete_campaign(campaign_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(CAMPAIGNS)):
    campaigns.delete(db, admin, campaign_id)
    return ok(message="Campaign deleted.")


@admin_campaigns_router.post("/{campaign_id}/duplicate", status_code=201, summary="Copy a campaign as a new draft")
def admin_duplicate_campaign(campaign_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(CAMPAIGNS)):
    return ok(campaigns.view(db, campaigns.duplicate(db, admin, campaign_id), full=True), message="Copied as a draft.")


@admin_campaigns_router.get("/{campaign_id}/preview", summary="The campaign's messages, as a sample customer sees them")
def admin_campaign_preview(campaign_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(CAMPAIGNS)):
    return ok(campaigns.preview(db, campaign_id))


class CampaignTestIn(CamelModel):
    email: str = Field(default="", max_length=255)
    phone: str = Field(default="", max_length=20)


@admin_campaigns_router.post("/{campaign_id}/test", summary="Send the campaign to yourself")
def admin_campaign_test(campaign_id: int, body: CampaignTestIn, db: Session = Depends(get_db),
                        admin: AdminUser = Depends(CAMPAIGNS)):
    rate_limit.check(f"campaign-test:{admin.id}", limit=10, window_seconds=300)
    return ok(campaigns.send_test(db, admin, campaign_id, email=body.email, phone=body.phone), message="Test sent.")


class LaunchIn(CamelModel):
    # The message count the admin was shown and confirmed. Must still be true.
    confirm_messages: int = Field(ge=0)
    send_at: Optional[str] = Field(default=None, max_length=40)


@admin_campaigns_router.post("/{campaign_id}/launch", summary="Launch (now or at a time) after confirming")
def admin_launch_campaign(campaign_id: int, body: LaunchIn, background: BackgroundTasks,
                          db: Session = Depends(get_db), admin: AdminUser = Depends(CAMPAIGNS)):
    row = campaigns.launch(db, admin, campaign_id, confirm_messages=body.confirm_messages, send_at=body.send_at)
    if row.status == "sending":
        # Start straight away, after the response, rather than at the job's next pass.
        background.add_task(campaigns.send_now)
    return ok(campaigns.view(db, row, full=True),
              message="Campaign scheduled." if row.status == "scheduled" else "Campaign is sending.")


@admin_campaigns_router.post("/{campaign_id}/cancel", summary="Stop a scheduled or sending campaign")
def admin_cancel_campaign(campaign_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(CAMPAIGNS)):
    return ok(campaigns.view(db, campaigns.cancel(db, admin, campaign_id), full=True), message="Campaign cancelled.")


@admin_campaigns_router.get("/{campaign_id}/recipients", summary="Who a campaign went to, and what happened")
def admin_campaign_recipients(campaign_id: int, channel: str = Query("", max_length=12),
                              status: str = Query("", max_length=12), page: int = Query(1, ge=1),
                              page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
                              db: Session = Depends(get_db), admin: AdminUser = Depends(CAMPAIGNS)):
    campaigns._load(db, campaign_id)
    conditions = [CampaignRecipient.campaign_id == campaign_id]
    if channel:
        conditions.append(CampaignRecipient.channel == channel)
    if status:
        conditions.append(CampaignRecipient.status == status)
    total = db.execute(select(func.count()).select_from(CampaignRecipient).where(*conditions)).scalar_one()
    rows = db.execute(select(CampaignRecipient, Customer).join(Customer, Customer.id == CampaignRecipient.customer_id)
                      .where(*conditions).order_by(CampaignRecipient.id).offset((page - 1) * page_size)
                      .limit(page_size)).all()
    deliveries = {d.id: d for d in db.execute(select(NotificationDelivery).where(
        NotificationDelivery.id.in_([r.delivery_id for r, _ in rows if r.delivery_id]))).scalars()} if rows else {}
    items = [{"id": r.id, "customer": {"id": c.id, "name": c.full_name}, "channel": r.channel, "status": r.status,
              "recipient": messaging.mask(deliveries[r.delivery_id].recipient) if r.delivery_id in deliveries else "",
              "error": deliveries[r.delivery_id].last_error if r.delivery_id in deliveries else "",
              "openedAt": r.opened_at, "clickedAt": r.clicked_at, "unsubscribedAt": r.unsubscribed_at,
              "repliedAt": r.replied_at, "createdAt": r.created_at} for r, c in rows]
    return ok({"items": items, "pagination": _page(page, page_size, total)})


# ------------------------------------------------------------------ backups

BACKUPS = require_access("backups")


@admin_backups_router.get("", summary="Backup status and history")
def admin_backups(status: str = Query("", max_length=12), page: int = Query(1, ge=1),
                  page_size: int = Query(25, ge=1, le=100, alias="pageSize"), db: Session = Depends(get_db),
                  admin: AdminUser = Depends(BACKUPS)):
    items, total, counts = backups.history(db, status=status, page=page, page_size=page_size)
    return ok({**backups.overview(db), "items": items, "pagination": _page(page, page_size, total), "counts": counts})


@admin_backups_router.put("/settings", summary="Backup schedule and retention")
def admin_backup_settings(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(BACKUPS)):
    return ok(backups.save_settings(db, admin, payload), message="Backup settings saved.")


@admin_backups_router.post("/run", summary="Back up now")
def admin_run_backup(db: Session = Depends(get_db), admin: AdminUser = Depends(BACKUPS)):
    rate_limit.check(f"backup-run:{admin.id}", limit=3, window_seconds=600)
    row = backups.start_manual(db, admin)
    view = backups.view(row)
    if row.status != "succeeded":
        from fastapi.encoders import jsonable_encoder

        # Encoded first: the view holds datetimes, which plain JSON cannot.
        return JSONResponse(jsonable_encoder({"success": False, "message": f"The backup failed: {row.error}",
                                              "error_code": "BACKUP_FAILED", "data": view}), status_code=500)
    return ok(view, message="Backup complete and verified.")


@admin_backups_router.post("/{backup_id}/download", summary="A five-minute download link")
def admin_backup_link(backup_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(BACKUPS)):
    return ok(backups.download_link(db, admin, backup_id))


@admin_backups_router.get("/{backup_id}/file", include_in_schema=False)
def admin_backup_file(backup_id: int, token: str = Query(..., max_length=300), db: Session = Depends(get_db)):
    """The file itself, for a signed link from /download. No header auth: a browser download can't send one."""
    handle, name = backups.open_for_download(db, backup_id, token)

    def stream():
        try:
            for chunk in iter(lambda: handle.read(backups.CHUNK), b""):
                yield chunk
        finally:
            handle.close()

    return StreamingResponse(stream(), media_type="application/octet-stream",
                             headers={"Content-Disposition": f'attachment; filename="{name}"',
                                      "Cache-Control": "no-store"})

