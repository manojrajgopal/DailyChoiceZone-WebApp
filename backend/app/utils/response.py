"""The response envelope every endpoint returns."""

from __future__ import annotations

from math import ceil
from typing import Any, Generic, List, Optional, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class Pagination(BaseModel):
    page: int
    page_size: int
    total: int
    total_pages: int

    @classmethod
    def build(cls, page: int, page_size: int, total: int) -> "Pagination":
        return cls(
            page=page,
            page_size=page_size,
            total=total,
            total_pages=ceil(total / page_size) if page_size else 0,
        )


class ApiResponse(BaseModel, Generic[T]):
    """
    One shape for every successful response.

    `success` is redundant next to the HTTP status and is here anyway, because
    a client that checks one field is a client that cannot forget to check the
    status code.
    """

    success: bool = True
    data: Optional[T] = None
    message: Optional[str] = None


class ApiListResponse(BaseModel, Generic[T]):
    success: bool = True
    data: List[T]
    pagination: Optional[Pagination] = None
    message: Optional[str] = None


class ApiError(BaseModel):
    success: bool = False
    message: str
    error_code: str
    # Field-level detail for validation failures. Absent otherwise, rather
    # than an empty object that a client has to distinguish from a real one.
    details: Optional[Any] = None


def ok(data: Any = None, message: Optional[str] = None) -> dict:
    return {"success": True, "data": data, "message": message}


def ok_list(
    data: List[Any],
    pagination: Optional[Pagination] = None,
    message: Optional[str] = None,
) -> dict:
    payload: dict = {"success": True, "data": data}
    if pagination is not None:
        payload["pagination"] = pagination.model_dump()
    if message is not None:
        payload["message"] = message
    return payload
