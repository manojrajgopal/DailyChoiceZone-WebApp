"""
Product questions and answers.

    GET  /api/products/{id}/questions          published questions (answered first), paged
    GET  /api/products/{id}/questions/mine     your own, including ones awaiting review
    POST /api/products/{id}/questions          ask (signed in; moderated before it shows)

    GET    /api/admin/questions                search, filter, page
    GET    /api/admin/questions/{id}           one, with its moderation history
    POST   /api/admin/questions/{id}/approve
    POST   /api/admin/questions/{id}/reject    with a reason
    PUT    /api/admin/questions/{id}/answer    write, edit, publish or unpublish the answer
    PUT    /api/admin/questions/{id}           edit the question's wording
    DELETE /api/admin/questions/{id}
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.dependencies.auth import client_ip, get_current_customer, require_access
from app.models import AdminUser, Customer
from app.schemas.base import CamelModel
from app.services import questions as service
from app.utils.response import Pagination, ok

router = APIRouter(prefix="/products/{identifier}/questions", tags=["Questions"])
admin_router = APIRouter(prefix="/admin/questions", tags=["Admin · Questions"])


@router.get("", summary="Questions and answers about a product")
def list_questions(
    identifier: str,
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(5, ge=1, le=20, alias="pageSize"),
    db: Session = Depends(get_db),
):
    rate_limit.check(f"qa-read:{client_ip(request)}", limit=300, window_seconds=300)
    items, total, answered = service.list_public(db, identifier[:160], page=page, page_size=page_size)
    return ok({"items": items, "pagination": Pagination.build(page, page_size, total).model_dump(),
               "answered": answered})


@router.get("/mine", summary="Your questions about this product")
def my_questions(identifier: str, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(service.list_mine_for_product(db, customer, identifier[:160]))


class AskRequest(CamelModel):
    question: str = Field(min_length=1, max_length=2000)
    size: str = Field(default="", max_length=30)
    color: str = Field(default="", max_length=60)


@router.post("", status_code=201, summary="Ask a question")
def ask(identifier: str, payload: AskRequest, db: Session = Depends(get_db),
        customer: Customer = Depends(get_current_customer)):
    rate_limit.check(f"qa-ask:{customer.id}", limit=5, window_seconds=3600,
                     message="You've asked several questions in a short time. Please try again later.")
    question = service.ask(db, customer, identifier[:160], payload.question, size=payload.size, color=payload.color)
    return ok(service.own_view(question),
              message="Thanks! Your question will appear once our team has reviewed it.")


# ------------------------------------------------------------------ admin


@admin_router.get("", summary="Product questions")
def list_all(
    status: str = Query("", max_length=20),
    answered: str = Query("", max_length=3),
    q: str = Query("", max_length=64, description="A Question ID, matched exactly."),
    product_id: str = Query("", max_length=64, alias="productId", description="A Product ID or SKU, exact."),
    customer_id: str = Query("", max_length=64, alias="customerId", description="A Customer ID, exact."),
    text: str = Query("", max_length=80, description="Words in the question itself."),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access("questions")),
):
    items, total, counts = service.search(db, status=status, answered=answered, q=q, product_id=product_id,
                                          customer_id=customer_id, text=text, page=page, page_size=page_size)
    return ok({"items": items, "pagination": Pagination.build(page, page_size, total).model_dump(), "counts": counts})


@admin_router.get("/{question_id}", summary="One question")
def detail(question_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("questions"))):
    return ok(service.admin_view(db, service.get(db, question_id), detail=True))


class ReasonRequest(CamelModel):
    reason: str = Field(default="", max_length=300)


@admin_router.post("/{question_id}/approve", summary="Publish a question")
def approve(question_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("questions"))):
    question = service.moderate(db, question_id, admin, action="approve")
    return ok(service.admin_view(db, question, detail=True), message="Question published.")


@admin_router.post("/{question_id}/reject", summary="Decline a question")
def reject(question_id: int, payload: ReasonRequest, db: Session = Depends(get_db),
           admin: AdminUser = Depends(require_access("questions"))):
    question = service.moderate(db, question_id, admin, action="reject", reason=payload.reason)
    return ok(service.admin_view(db, question, detail=True), message="Question declined.")


class AnswerRequest(CamelModel):
    answer: str = Field(min_length=1, max_length=4000)
    publish: bool = True
    # Answering a pending question publishes the question too, when set.
    approve: bool = False


@admin_router.put("/{question_id}/answer", summary="Write or edit the answer")
def answer(question_id: int, payload: AnswerRequest, db: Session = Depends(get_db),
           admin: AdminUser = Depends(require_access("questions"))):
    question = service.answer(db, question_id, admin, payload.answer, publish=payload.publish, approve=payload.approve)
    return ok(service.admin_view(db, question, detail=True),
              message="Answer published." if payload.publish else "Answer saved as a draft.")


class EditRequest(CamelModel):
    question: str = Field(min_length=1, max_length=2000)


@admin_router.put("/{question_id}", summary="Edit a question's wording")
def edit(question_id: int, payload: EditRequest, db: Session = Depends(get_db),
         admin: AdminUser = Depends(require_access("questions"))):
    question = service.edit_question(db, question_id, admin, payload.question)
    return ok(service.admin_view(db, question, detail=True), message="Question updated.")


@admin_router.delete("/{question_id}", summary="Delete a question")
def delete(question_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("questions"))):
    service.delete(db, question_id)
    return ok(message="Question deleted.")
