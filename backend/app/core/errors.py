"""Application exceptions and the handlers that render them."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)


class AppError(Exception):
    """
    A failure the API knows how to describe.

    Every one carries an `error_code` the frontend can branch on, because
    matching on a human-readable message is a contract nobody agreed to and
    that breaks the moment someone improves the wording.
    """

    status_code = status.HTTP_400_BAD_REQUEST
    error_code = "BAD_REQUEST"

    def __init__(self, message: str, *, error_code: Optional[str] = None, details: Any = None):
        super().__init__(message)
        self.message = message
        if error_code:
            self.error_code = error_code
        self.details = details


class NotFoundError(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    error_code = "NOT_FOUND"


class ConflictError(AppError):
    """A request that contradicts something already true — a duplicate code, a
    category still in use, an order already cancelled."""

    status_code = status.HTTP_409_CONFLICT
    error_code = "CONFLICT"


class ValidationError(AppError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    error_code = "VALIDATION_ERROR"


class AuthenticationError(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    error_code = "UNAUTHENTICATED"


class AuthorizationError(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    error_code = "FORBIDDEN"


class BusinessRuleError(AppError):
    """A well-formed request the business rules refuse: refunding more than was
    collected, ordering more than is in stock."""

    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    error_code = "BUSINESS_RULE_VIOLATION"


def _payload(message: str, error_code: str, details: Any = None) -> dict:
    body: dict = {"success": False, "message": message, "error_code": error_code}
    if details is not None:
        body["details"] = details
    return body


def register_error_handlers(app: FastAPI) -> None:
    """
    Install the handlers.

    The rule they all share: **a client is told what it can act on, and nothing
    else.** A database error becomes "something went wrong on our side" with a
    reference, while the driver's message — which quotes table names, column
    names and sometimes row data — goes to the log where it belongs.
    """

    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(exc.message, exc.error_code, exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Reshaped into something a form can consume: which field, and why.
        details = [
            {
                "field": ".".join(str(part) for part in error["loc"][1:]) or str(error["loc"][0]),
                "message": error["msg"],
            }
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content=_payload("The request could not be validated.", "VALIDATION_ERROR", details),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        codes = {
            401: "UNAUTHENTICATED",
            403: "FORBIDDEN",
            404: "NOT_FOUND",
            405: "METHOD_NOT_ALLOWED",
        }
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(str(exc.detail), codes.get(exc.status_code, "HTTP_ERROR")),
        )

    @app.exception_handler(IntegrityError)
    async def _integrity(request: Request, exc: IntegrityError) -> JSONResponse:
        # Nearly always a unique constraint. Saying which one would leak the
        # schema, so the client gets the shape of the problem and the log gets
        # the specifics.
        logger.warning("Integrity error on %s %s: %s", request.method, request.url.path, exc.orig)
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=_payload(
                "That conflicts with a record that already exists.",
                "DUPLICATE_RECORD",
            ),
        )

    @app.exception_handler(SQLAlchemyError)
    async def _database(request: Request, exc: SQLAlchemyError) -> JSONResponse:
        logger.exception("Database error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_payload("A database error occurred.", "DATABASE_ERROR"),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_payload("Something went wrong on our side.", "INTERNAL_ERROR"),
        )
