"""
Product questions and answers.

## Moderated, always

A question is `pending` when asked and appears on the product page only once
a moderator approves it. The store's answer appears once it is published on an
approved question. Customers see their own pending questions (so they know
it was received), and nobody else's.

## Text in, text out

Questions and answers are stored as plain text: markup is stripped on the way
in, control characters removed, whitespace tidied, and the storefront renders
it as text. Links are refused in questions — a question with a URL in it is
almost always an advert.

## Abuse

Signed-in customers only, a few questions an hour each, and the same question
on the same product can't be asked twice while the first is pending or live.
"""

from __future__ import annotations

import hashlib
import html as html_lib
import re
from datetime import datetime
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.config import settings as app_settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    AdminUser,
    Customer,
    Product,
    ProductAnswer,
    ProductQuestion,
    ProductQuestionEvent,
)

QUESTION_MIN, QUESTION_MAX = 10, 500
ANSWER_MIN, ANSWER_MAX = 2, 2000
EMAIL_TYPE = "product_questions"

_TAGS = re.compile(r"<[^>]*>")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏‪-‮⁦-⁩]")
_SPACES = re.compile(r"[ \t]+")
_BLANK_LINES = re.compile(r"\n{3,}")
_LINK = re.compile(r"(https?://|www\.|\b[a-z0-9-]+\.(com|in|net|org|io|xyz|ru|co)\b)", re.IGNORECASE)


def clean_text(value: str) -> str:
    """Plain text: no markup, no control or direction-override characters, tidy whitespace."""
    text = html_lib.unescape(value or "")
    text = _TAGS.sub("", text)
    text = _CONTROL.sub("", text).replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(_SPACES.sub(" ", line).strip() for line in text.split("\n"))
    return _BLANK_LINES.sub("\n\n", text).strip()


def _hash(text: str) -> str:
    normal = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
    return hashlib.sha256(normal.encode("utf-8")).hexdigest()


def _author(customer: Customer) -> str:
    first = (customer.first_name or "").strip() or "Customer"
    last = (customer.last_name or "").strip()
    return f"{first} {last[0]}." if last else first


# ------------------------------------------------------------- storefront


def public_view(question: ProductQuestion) -> dict:
    answer = question.answer if question.answer and question.answer.published else None
    return {
        "id": question.id,
        "question": question.body,
        "author": question.author_name,
        "size": question.size or None,
        "color": question.color or None,
        "askedAt": question.created_at,
        "answer": {"body": answer.body, "by": answer.admin_name or "Daily Choice Zone",
                   "answeredAt": answer.published_at} if answer else None,
    }


def own_view(question: ProductQuestion) -> dict:
    out = public_view(question)
    out.update({"status": question.status,
                "rejectionReason": question.rejection_reason if question.status == "rejected" else ""})
    return out


def _listed_product(db: Session, identifier: str) -> Product:
    from app.repositories import products as repo

    product = repo.get_by_identifier(db, identifier, published_only=True)
    if product is None:
        raise NotFoundError("That product is not available.", error_code="PRODUCT_NOT_FOUND")
    return product


def list_public(db: Session, product_identifier: str, *, page: int = 1, page_size: int = 5,
                answered_only: bool = False) -> tuple:
    product = _listed_product(db, product_identifier)
    conditions = [ProductQuestion.product_id == product.id, ProductQuestion.status == "approved"]
    if answered_only:
        conditions.append(ProductQuestion.id.in_(select(ProductAnswer.question_id).where(ProductAnswer.published.is_(True))))
    total = db.execute(select(func.count()).select_from(ProductQuestion).where(*conditions)).scalar_one()
    rows = db.execute(
        select(ProductQuestion).options(selectinload(ProductQuestion.answer)).where(*conditions)
        # Answered questions first — they're the useful ones — newest first within.
        .order_by(ProductQuestion.id.in_(select(ProductAnswer.question_id).where(ProductAnswer.published.is_(True))).desc(),
                  ProductQuestion.created_at.desc(), ProductQuestion.id.desc())
        .offset((max(1, page) - 1) * page_size).limit(page_size)
    ).scalars().all()
    answered = db.execute(select(func.count()).select_from(ProductQuestion).where(
        ProductQuestion.product_id == product.id, ProductQuestion.status == "approved",
        ProductQuestion.id.in_(select(ProductAnswer.question_id).where(ProductAnswer.published.is_(True))),
    )).scalar_one()
    return [public_view(q) for q in rows], total, answered


def list_mine_for_product(db: Session, customer: Customer, product_identifier: str) -> list:
    product = _listed_product(db, product_identifier)
    rows = db.execute(select(ProductQuestion).where(
        ProductQuestion.product_id == product.id, ProductQuestion.customer_id == customer.id,
    ).order_by(ProductQuestion.created_at.desc()).limit(20)).scalars().all()
    return [own_view(q) for q in rows]


def ask(db: Session, customer: Customer, product_identifier: str, body: str, *, size: str = "",
        color: str = "") -> ProductQuestion:
    product = _listed_product(db, product_identifier)
    text = clean_text(body)
    if len(text) < QUESTION_MIN:
        raise ValidationError(f"Please write at least {QUESTION_MIN} characters.", error_code="QUESTION_TOO_SHORT")
    if len(text) > QUESTION_MAX:
        raise ValidationError(f"Please keep it under {QUESTION_MAX} characters.", error_code="QUESTION_TOO_LONG")
    if _LINK.search(text):
        raise ValidationError("Please leave out links and web addresses.", error_code="QUESTION_HAS_LINK")
    size = (size or "").strip()[:30]
    color = (color or "").strip()[:60]
    if size and size not in [s.label for s in product.sizes]:
        size = ""
    if color and color not in [c.name for c in product.colors]:
        color = ""

    digest = _hash(text)
    duplicate = db.execute(select(ProductQuestion.id).where(
        ProductQuestion.customer_id == customer.id, ProductQuestion.product_id == product.id,
        ProductQuestion.body_hash == digest, ProductQuestion.status.in_(("pending", "approved")),
    )).first()
    if duplicate:
        raise ConflictError("You've already asked this question — we'll answer it soon.", error_code="DUPLICATE_QUESTION")

    now = datetime.utcnow()
    question = ProductQuestion(product_id=product.id, customer_id=customer.id, author_name=_author(customer),
                               size=size, color=color, body=text, body_hash=digest, status="pending",
                               created_at=now, updated_at=now)
    question.events.append(ProductQuestionEvent(action="asked", note="", created_at=now))
    db.add(question)
    db.flush()
    _email(db, question, product, customer, "received")
    from app.services import inbox

    inbox.staff(db, "question", f"New question about {product.name}", text[:200], "/admin/questions?status=pending",
                permission="questions")
    db.commit()
    db.refresh(question)
    return question


# ------------------------------------------------------------------ emails


def _email(db: Session, question: ProductQuestion, product: Product, customer: Optional[Customer], what: str) -> bool:
    from app.services import email as email_service

    if customer is None or customer.status != "active":
        return False
    esc = html_lib.escape
    link = f"{app_settings.STOREFRONT_URL.rstrip('/')}/product/{product.slug}#questions"
    quote = (f'<p style="margin:18px 0 0;padding:12px 14px;background:#faf7f2;border-left:3px solid #c08457;'
             f'font-size:14px;line-height:1.6;color:#1e1b18">{esc(question.body)}</p>')
    hello = f"Hello {esc(customer.first_name or 'there')},"
    if what == "received":
        subject, title = f"We've got your question about {product.name}", "Thanks for your question"
        intro = (f"{hello} we've received your question about <strong>{esc(product.name)}</strong>. Our team "
                 "reviews every question before it appears on the product page, and we'll email you when it's answered.")
        rows = quote
    elif what == "approved":
        subject, title = f"Your question about {product.name} is live", "Your question is published"
        intro = (f"{hello} your question about <strong>{esc(product.name)}</strong> is now on the product page. "
                 "We'll email you when it's answered.")
        rows = quote
    elif what == "rejected":
        subject, title = f"About your question on {product.name}", "We couldn't publish your question"
        reason = f" Reason: {esc(question.rejection_reason)}." if question.rejection_reason else ""
        intro = (f"{hello} we weren't able to publish your question about <strong>{esc(product.name)}</strong>."
                 f"{reason} If you need help with an order, our support team can help.")
        rows = quote
    else:
        answer = question.answer
        subject, title = f"Your question about {product.name} has been answered", "Your question has an answer"
        intro = f"{hello} we've answered your question about <strong>{esc(product.name)}</strong>."
        rows = quote + (f'<p style="margin:14px 0 0;font-size:14px;line-height:1.6;color:#1e1b18">'
                        f'<strong>Answer:</strong> {esc(answer.body if answer else "")}</p>')
    html = email_service.layout(title, intro, rows, cta=("View on the product page", link))
    text = f"{title}. {product.name}: {question.body}\n{link}"
    return email_service.notify(db, EMAIL_TYPE, to=customer.email, customer_id=customer.id, subject=subject,
                                html=html, text=text, reference=f"question-{question.id}")


# ------------------------------------------------------------------- admin


def _event(question: ProductQuestion, action: str, admin: Optional[AdminUser], note: str = "") -> None:
    question.events.append(ProductQuestionEvent(
        action=action, note=(note or "")[:500], admin_id=admin.id if admin else None,
        admin_name=(admin.name if admin else "")[:120], created_at=datetime.utcnow(),
    ))


def get(db: Session, question_id: int, *, lock: bool = False) -> ProductQuestion:
    query = select(ProductQuestion).where(ProductQuestion.id == question_id)
    question = db.execute(query.with_for_update() if lock else query).scalar_one_or_none()
    if question is None:
        raise NotFoundError("No such question.", error_code="QUESTION_NOT_FOUND")
    return question


def admin_view(db: Session, question: ProductQuestion, *, detail: bool = False) -> dict:
    product = db.get(Product, question.product_id)
    customer = db.get(Customer, question.customer_id) if question.customer_id else None
    answer = question.answer
    out = {
        "id": question.id, "status": question.status, "question": question.body,
        "author": question.author_name, "size": question.size, "color": question.color,
        "rejectionReason": question.rejection_reason, "askedAt": question.created_at,
        "moderatedAt": question.moderated_at,
        "product": {"id": product.id, "name": product.name, "slug": product.slug, "status": product.status} if product else None,
        "customer": {"id": customer.id, "name": customer.full_name, "email": customer.email} if customer else None,
        "answer": {"body": answer.body, "published": answer.published, "by": answer.admin_name,
                   "updatedAt": answer.updated_at, "publishedAt": answer.published_at} if answer else None,
    }
    if detail:
        out["events"] = [{"action": e.action, "note": e.note, "by": e.admin_name, "at": e.created_at}
                         for e in question.events]
    return out


def search(db: Session, *, status: str = "", answered: str = "", q: str = "", product_id: str = "",
           customer_id: str = "", page: int = 1, page_size: int = 25) -> tuple:
    conditions = []
    if status in ("pending", "approved", "rejected"):
        conditions.append(ProductQuestion.status == status)
    published = select(ProductAnswer.question_id).where(ProductAnswer.published.is_(True))
    if answered == "yes":
        conditions.append(ProductQuestion.id.in_(published))
    elif answered == "no":
        conditions.append(ProductQuestion.id.notin_(published))
    if product_id:
        conditions.append(ProductQuestion.product_id == product_id)
    if customer_id:
        conditions.append(ProductQuestion.customer_id == customer_id)
    text = (q or "").strip()
    if text:
        like = f"%{text}%"
        goods = select(Product.id).where(or_(Product.name.ilike(like), Product.sku.ilike(like)))
        people = select(Customer.id).where(or_(Customer.email.ilike(like), Customer.first_name.ilike(like),
                                               Customer.last_name.ilike(like)))
        conditions.append(or_(ProductQuestion.body.ilike(like), ProductQuestion.product_id.in_(goods),
                              ProductQuestion.customer_id.in_(people)))
    total = db.execute(select(func.count()).select_from(ProductQuestion).where(*conditions)).scalar_one()
    rows = db.execute(select(ProductQuestion).options(selectinload(ProductQuestion.answer)).where(*conditions)
                      .order_by(ProductQuestion.created_at.desc(), ProductQuestion.id.desc())
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).scalars().all()
    counts = dict(db.execute(select(ProductQuestion.status, func.count()).group_by(ProductQuestion.status)).all())
    counts["unanswered"] = db.execute(select(func.count()).select_from(ProductQuestion).where(
        ProductQuestion.status == "approved", ProductQuestion.id.notin_(published))).scalar_one()
    return [admin_view(db, r) for r in rows], total, counts


def pending_count(db: Session) -> int:
    return db.execute(select(func.count()).select_from(ProductQuestion).where(ProductQuestion.status == "pending")).scalar_one()


def moderate(db: Session, question_id: int, admin: AdminUser, *, action: str, reason: str = "") -> ProductQuestion:
    question = get(db, question_id, lock=True)
    reason = clean_text(reason)[:300]
    now = datetime.utcnow()
    if action == "approve":
        if question.status == "approved":
            return question
        question.status, question.rejection_reason = "approved", ""
        what = "approved"
    elif action == "reject":
        if question.status == "rejected":
            return question
        question.status, question.rejection_reason = "rejected", reason
        if question.answer is not None:
            question.answer.published = False
        what = "rejected"
    else:
        raise ValidationError("Approve or reject.", error_code="INVALID_ACTION")
    question.moderated_at, question.moderated_by, question.updated_at = now, admin.id, now
    _event(question, what, admin, reason)
    product = db.get(Product, question.product_id)
    customer = db.get(Customer, question.customer_id) if question.customer_id else None
    if product is not None:
        # An answer published at the same moment as approval is announced
        # once, as the answer, rather than as two emails.
        if what == "approved" and question.answer is not None and question.answer.published:
            _email(db, question, product, customer, "answered")
        else:
            _email(db, question, product, customer, what)
    db.commit()
    db.refresh(question)
    return question


def answer(db: Session, question_id: int, admin: AdminUser, body: str, *, publish: bool = True,
           approve: bool = False) -> ProductQuestion:
    question = get(db, question_id, lock=True)
    text = clean_text(body)
    if len(text) < ANSWER_MIN:
        raise ValidationError("Write an answer.", error_code="ANSWER_TOO_SHORT")
    if len(text) > ANSWER_MAX:
        raise ValidationError(f"Keep the answer under {ANSWER_MAX} characters.", error_code="ANSWER_TOO_LONG")
    if question.status == "rejected":
        raise ConflictError("Approve the question before answering it.", error_code="QUESTION_REJECTED")
    now = datetime.utcnow()
    approved_now = False
    if question.status == "pending":
        if not approve:
            raise ConflictError("Approve the question before publishing an answer.", error_code="QUESTION_PENDING")
        question.status, question.moderated_at, question.moderated_by = "approved", now, admin.id
        _event(question, "approved", admin)
        approved_now = True

    existing = question.answer
    first_publish = publish and (existing is None or not existing.published)
    if existing is None:
        question.answer = ProductAnswer(body=text, published=publish, admin_id=admin.id, admin_name=admin.name[:120],
                                        created_at=now, updated_at=now, published_at=now if publish else None)
        _event(question, "answered" if publish else "answer-drafted", admin)
    else:
        changed = existing.body != text
        existing.body, existing.admin_id, existing.admin_name = text, admin.id, admin.name[:120]
        existing.updated_at = now
        if publish and not existing.published:
            existing.published, existing.published_at = True, now
            _event(question, "answered", admin)
        elif not publish and existing.published:
            existing.published = False
            _event(question, "answer-unpublished", admin)
        elif changed:
            _event(question, "answer-edited", admin)
    question.updated_at = now
    if first_publish:
        product = db.get(Product, question.product_id)
        customer = db.get(Customer, question.customer_id) if question.customer_id else None
        if product is not None:
            _email(db, question, product, customer, "answered")
    elif approved_now:
        product = db.get(Product, question.product_id)
        customer = db.get(Customer, question.customer_id) if question.customer_id else None
        if product is not None:
            _email(db, question, product, customer, "approved")
    db.commit()
    db.refresh(question)
    return question


def edit_question(db: Session, question_id: int, admin: AdminUser, body: str) -> ProductQuestion:
    """Fix a typo or remove personal details before publishing. The edit is in the history."""
    question = get(db, question_id, lock=True)
    text = clean_text(body)
    if not QUESTION_MIN <= len(text) <= QUESTION_MAX:
        raise ValidationError(f"Questions are {QUESTION_MIN}–{QUESTION_MAX} characters.", error_code="QUESTION_LENGTH")
    if text != question.body:
        question.body, question.body_hash = text, _hash(text)
        question.updated_at = datetime.utcnow()
        _event(question, "edited", admin)
        db.commit()
        db.refresh(question)
    return question


def delete(db: Session, question_id: int) -> None:
    question = get(db, question_id)
    db.delete(question)
    db.commit()
