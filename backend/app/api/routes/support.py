"""
The customer side of support: the contact centre, their tickets and the chat.

Signed in, a customer reaches their tickets by account. A guest reaches one
ticket with the key emailed to them, sent in the `X-Ticket-Key` header — never
as a parameter a server log would keep. Every refusal is the same 404.
"""

from __future__ import annotations

import json
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, Header, Query, Request, UploadFile
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.dependencies.auth import client_ip, get_current_customer, get_optional_customer
from app.models import Customer, CustomerNotification, SupportArticle, SupportCategory, TicketAttachment
from app.schemas.base import CamelModel
from app.services.support import admin_config, config, queries
from app.services.support import attachments as files
from app.services.support import tickets as service
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/support", tags=["Support"])

MAX_UPLOAD_BYTES = 100 * 1024 * 1024


async def _read(uploads: Optional[List[UploadFile]], db: Session) -> list:
    """The uploaded files' bytes — refusing an oversized one before reading it all."""
    limits = config.settings(db).get("attachments") or {}
    cap = max(int(limits.get("maxSizeMb") or 10), int(limits.get("maxVideoSizeMb") or 25)) * 1024 * 1024
    out = []
    for upload in uploads or []:
        if not upload.filename:
            continue
        data = await upload.read(min(cap, MAX_UPLOAD_BYTES) + 1)
        if len(data) > cap:
            raise ValidationError(f"{files.clean_name(upload.filename)} is too large.", error_code="FILE_TOO_LARGE")
        out.append((upload.filename, data))
    return out


def _payload(data: str) -> dict:
    try:
        value = json.loads(data or "{}")
    except ValueError:
        raise ValidationError("We couldn't read that request.", error_code="INVALID_PAYLOAD") from None
    if not isinstance(value, dict):
        raise ValidationError("We couldn't read that request.", error_code="INVALID_PAYLOAD")
    return value


def _ticket(db: Session, number: str, customer: Optional[Customer], key: Optional[str]):
    return service.find_for_customer(db, number, customer=customer, key=key or "")


# --------------------------------------------------------------- the centre


@router.get("/config", summary="What the contact centre offers")
def support_config(db: Session = Depends(get_db)):
    conf = config.settings(db)
    return ok({
        "categories": config.tree(db, active_only=True),
        "chat": config.chat_status(db),
        "hours": config.hours_summary(db),
        "open": config.is_open(db),
        "attachments": {"enabled": files.enabled(), **(conf.get("attachments") or {})},
        "reopenDays": conf.get("reopenDays", 7),
        "responseTargets": {p: (conf.get("sla") or {}).get(p, {}).get("response") for p in config.PRIORITIES},
    })


@router.get("/categories/{category_id}/handlers", summary="Who the customer may choose to handle a request")
def handlers(category_id: int, db: Session = Depends(get_db)):
    node = db.get(SupportCategory, category_id)
    if node is None or not node.active:
        raise NotFoundError("No such option.", error_code="CATEGORY_NOT_FOUND")
    return ok(service.selectable(db, node))


@router.get("/articles", summary="Help articles")
def articles(q: str = Query("", max_length=200), categories: str = Query("", max_length=200),
             db: Session = Depends(get_db)):
    ids = [int(i) for i in categories.split(",") if i.strip().isdigit()]
    return ok_list([admin_config.article_view(a, full=False) for a in admin_config.search_articles(db, q, ids)])


@router.get("/articles/{slug}", summary="One help article")
def article(slug: str, db: Session = Depends(get_db)):
    row = db.execute(select(SupportArticle).where(SupportArticle.slug == slug, SupportArticle.active.is_(True))).scalar_one_or_none()
    if row is None:
        raise NotFoundError("We couldn't find that article.", error_code="ARTICLE_NOT_FOUND")
    row.views += 1
    db.commit()
    return ok(admin_config.article_view(row))


class ArticleFeedback(CamelModel):
    helpful: bool


@router.post("/articles/{article_id}/feedback", summary="Did the article help?")
def article_feedback(article_id: int, payload: ArticleFeedback, request: Request, db: Session = Depends(get_db)):
    rate_limit.check(f"article:{client_ip(request)}", limit=30, window_seconds=600)
    row = db.get(SupportArticle, article_id)
    if row is None:
        raise NotFoundError("We couldn't find that article.", error_code="ARTICLE_NOT_FOUND")
    if payload.helpful:
        row.helpful += 1
    else:
        row.not_helpful += 1
    db.commit()
    return ok(message="Thanks for letting us know.")


# ------------------------------------------------------------------ tickets


class DuplicateCheck(CamelModel):
    category_id: Optional[int] = None
    subcategory_id: Optional[int] = None
    issue_id: Optional[int] = None
    order_id: Optional[str] = None


@router.post("/tickets/duplicates", summary="Open requests about the same thing")
def duplicate_check(payload: DuplicateCheck, db: Session = Depends(get_db),
                    customer: Customer = Depends(get_current_customer)):
    found = service.duplicates(db, customer, {
        "categoryId": payload.category_id, "subcategoryId": payload.subcategory_id,
        "issueId": payload.issue_id, "orderId": payload.order_id,
    })
    return ok_list([service.row(db, t, audience="customer") for t in found])


def _limit_creation(request: Request, email: str) -> None:
    ip = client_ip(request)
    message = "You've sent several requests just now. Please wait a few minutes before sending another."
    rate_limit.check(f"ticket:ip:{ip}", limit=8, window_seconds=600, message=message)
    if email:
        rate_limit.check(f"ticket:email:{email.lower()}", limit=5, window_seconds=600, message=message)


@router.post("/tickets", status_code=201, summary="Raise a request")
async def create_ticket(
    request: Request,
    data: str = Form(...),
    files_in: Optional[List[UploadFile]] = File(None, alias="files"),
    db: Session = Depends(get_db),
    customer: Optional[Customer] = Depends(get_optional_customer),
):
    payload = _payload(data)
    _limit_creation(request, customer.email if customer else str(payload.get("email") or ""))
    uploads = await _read(files_in, db)
    ticket, key = service.create(db, payload, customer=customer, uploads=uploads,
                                 user_agent=request.headers.get("user-agent", ""))
    return ok({"ticket": service.customer_view(db, ticket), "key": key or None},
              message=f"We've received your request {ticket.number}.")


@router.post("/chat", status_code=201, summary="Start a live chat")
async def start_chat(
    request: Request,
    data: str = Form(...),
    files_in: Optional[List[UploadFile]] = File(None, alias="files"),
    db: Session = Depends(get_db),
    customer: Optional[Customer] = Depends(get_optional_customer),
):
    """A chat is a ticket on the chat channel, so it keeps its history and follows the same rules."""
    status = config.chat_status(db)
    if not status["available"]:
        # Offered only while someone is there to answer; the page falls back
        # to raising a request, which the same people pick up later.
        raise ConflictError("Live chat isn't available right now — please send us a request instead.",
                            error_code="CHAT_UNAVAILABLE", details=status)
    payload = _payload(data)
    _limit_creation(request, customer.email if customer else str(payload.get("email") or ""))
    uploads = await _read(files_in, db)
    payload.setdefault("subject", "Live chat")
    ticket, key = service.create(db, payload, customer=customer, uploads=uploads,
                                 user_agent=request.headers.get("user-agent", ""), channel="chat")
    return ok({"ticket": service.customer_view(db, ticket), "key": key or None, "chat": config.chat_status(db)})


@router.get("/tickets", summary="The customer's own requests")
def my_tickets(
    status: str = Query("", max_length=20),
    q: str = Query("", max_length=100),
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    rows = queries.customer_tickets(db, customer, group=status, query=q)
    return ok_list([service.row(db, t, audience="customer") for t in rows])


@router.get("/tickets/{number}", summary="One request and its conversation")
def get_ticket(
    number: str,
    db: Session = Depends(get_db),
    customer: Optional[Customer] = Depends(get_optional_customer),
    x_ticket_key: Optional[str] = Header(None),
):
    ticket = _ticket(db, number, customer, x_ticket_key)
    return ok(service.customer_view(db, ticket))


@router.post("/tickets/{number}/messages", status_code=201, summary="Reply on a request")
async def reply(
    number: str,
    request: Request,
    body: str = Form(""),
    files_in: Optional[List[UploadFile]] = File(None, alias="files"),
    db: Session = Depends(get_db),
    customer: Optional[Customer] = Depends(get_optional_customer),
    x_ticket_key: Optional[str] = Header(None),
):
    ticket = _ticket(db, number, customer, x_ticket_key)
    rate_limit.check(f"reply:{ticket.id}:{client_ip(request)}", limit=30, window_seconds=300)
    uploads = await _read(files_in, db)
    service.customer_message(db, ticket, body, uploads, customer=customer)
    db.refresh(ticket)
    return ok(service.customer_view(db, ticket))


@router.post("/tickets/{number}/read", summary="Mark the conversation as read")
def read(number: str, db: Session = Depends(get_db), customer: Optional[Customer] = Depends(get_optional_customer),
         x_ticket_key: Optional[str] = Header(None)):
    ticket = _ticket(db, number, customer, x_ticket_key)
    service.mark_read(db, ticket, "customer")
    if customer is not None:
        db.execute(update(CustomerNotification).where(
            CustomerNotification.customer_id == customer.id, CustomerNotification.read.is_(False),
            CustomerNotification.href == f"/account/ticket?number={ticket.number}",
        ).values(read=True))
        db.commit()
    return ok()


@router.post("/tickets/{number}/typing", summary="The customer is typing")
def customer_typing(number: str, db: Session = Depends(get_db),
                    customer: Optional[Customer] = Depends(get_optional_customer),
                    x_ticket_key: Optional[str] = Header(None)):
    service.typing(db, _ticket(db, number, customer, x_ticket_key), "customer")
    return ok()


@router.post("/tickets/{number}/close", summary="Close a request")
def close(number: str, db: Session = Depends(get_db), customer: Optional[Customer] = Depends(get_optional_customer),
          x_ticket_key: Optional[str] = Header(None)):
    ticket = service.customer_close(db, _ticket(db, number, customer, x_ticket_key), customer)
    return ok(service.customer_view(db, ticket), message="Your request is closed.")


class Reopen(CamelModel):
    reason: str = ""


@router.post("/tickets/{number}/reopen", summary="Reopen a request")
def reopen(number: str, payload: Reopen, db: Session = Depends(get_db),
           customer: Optional[Customer] = Depends(get_optional_customer), x_ticket_key: Optional[str] = Header(None)):
    ticket = service.customer_reopen(db, _ticket(db, number, customer, x_ticket_key), customer, payload.reason)
    return ok(service.customer_view(db, ticket), message="Your request is open again.")


class Rating(CamelModel):
    rating: int
    comment: str = ""


@router.post("/tickets/{number}/feedback", summary="Rate the help received")
def rate(number: str, payload: Rating, db: Session = Depends(get_db),
         customer: Optional[Customer] = Depends(get_optional_customer), x_ticket_key: Optional[str] = Header(None)):
    ticket = _ticket(db, number, customer, x_ticket_key)
    service.feedback(db, ticket, payload.rating, payload.comment)
    return ok(service.customer_view(db, ticket), message="Thank you for your feedback.")


@router.get("/tickets/{number}/attachments/{attachment_id}", summary="A short-lived link to a file")
def attachment(number: str, attachment_id: int, db: Session = Depends(get_db),
               customer: Optional[Customer] = Depends(get_optional_customer),
               x_ticket_key: Optional[str] = Header(None)):
    ticket = _ticket(db, number, customer, x_ticket_key)
    row = db.get(TicketAttachment, attachment_id)
    # A staff-only file is as invisible as a missing one.
    if row is None or row.ticket_id != ticket.id or row.internal:
        raise NotFoundError("We couldn't find that file.", error_code="ATTACHMENT_NOT_FOUND")
    return ok({"url": files.link(row), "name": row.file_name, "contentType": row.content_type})


# ------------------------------------------------------------ notifications


@router.get("/notifications", summary="The customer's notifications (every kind)")
def notifications(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    rows = db.execute(
        select(CustomerNotification).where(CustomerNotification.customer_id == customer.id)
        .order_by(CustomerNotification.created_at.desc()).limit(30)
    ).scalars().all()
    return ok_list([{"id": r.id, "kind": r.kind, "title": r.title, "body": r.body, "href": r.href,
                     "read": r.read, "at": r.created_at} for r in rows])


@router.post("/notifications/read", summary="Mark every notification as read")
def notifications_read(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    db.execute(update(CustomerNotification).where(
        CustomerNotification.customer_id == customer.id, CustomerNotification.read.is_(False)).values(read=True))
    db.commit()
    return ok()
