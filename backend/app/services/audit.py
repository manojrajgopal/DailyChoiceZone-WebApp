"""
The audit trail: who did what in the portal, and when.

## How entries are written

- **Every change an administrator makes is recorded**, by `capture` — a
  dependency on every router (see `main`). After a request that changes
  something (POST, PUT, PATCH, DELETE) made with an administrator's token, or
  any request an administrator was refused, it writes one entry: who, what
  route, which record, success or failure. Nothing has to remember to call it.
- **Where the detail matters**, the service doing the work calls `record`
  with what changed — a price from ₹999 to ₹799, a role from editor to admin.
  That entry replaces the generic one for the request.
- **Sign-ins** are recorded by the login route itself, including failed ones.

Everything about an entry comes from the server: the actor from the verified
token, the address from the connection, the time from the clock. Nothing the
browser says about who it is or what it did is taken on trust.

## What is never stored

Passwords, tokens, API keys and secrets, card details, one-time codes, gift
card codes. `redact` blanks them by field name and by what the value looks
like, before anything is written. Request bodies are not stored at all by the
generic entry — only the route, the method and the record's id.

## Immutable

There is no endpoint that changes or removes an entry, and the session refuses
to flush an update or a delete of one, or run a bulk UPDATE or DELETE on the
table — so a bug elsewhere can't quietly rewrite history either.
"""

from __future__ import annotations

import logging
import re
import secrets
from contextvars import ContextVar
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Iterable, Optional

from fastapi import Depends, Request
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import AuditLog

logger = logging.getLogger(__name__)

MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
REDACTED = "[redacted]"

# Field names that hold a secret, matched word by word (camelCase and
# snake_case are split first), so `pincode` is not mistaken for a PIN and
# `tokenised` is not either — but `api_key`, `clientSecret`, `refreshToken`,
# `password_hash` and `cardNumber` are caught.
_SECRET_WORDS = {
    "password", "passwd", "pwd", "secret", "token", "otp", "cvv", "cvc", "authorization", "cookie",
    "signature", "credential", "credentials", "hash", "salt", "apikey", "passphrase", "privatekey",
}
_SECRET_PAIRS = {("api", "key"), ("card", "number"), ("private", "key"), ("access", "key"), ("auth", "header"),
                 ("gift", "code"), ("card", "code"), ("refresh", "token"), ("client", "secret")}
# Values that are secrets whatever they are called.
_SECRET_VALUE = re.compile(
    r"^(Bearer\s+\S+|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*|rzp_(live|test)_\w+|sk_(live|test)_\w+|\$2[aby]\$\d\d\$.+)$"
)
_WORD = re.compile(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])")

_context: ContextVar[Optional[dict]] = ContextVar("audit_request", default=None)


# ------------------------------------------------------------------ redaction


def _words(key: str) -> list:
    return [w.lower() for w in _WORD.findall(str(key).replace("-", "_"))]


def is_secret_key(key: str) -> bool:
    words = _words(key)
    if any(w in _SECRET_WORDS for w in words):
        return True
    return any((a, b) in _SECRET_PAIRS for a, b in zip(words, words[1:]))


def redact(value: Any, key: Optional[str] = None, *, depth: int = 0) -> Any:
    """A copy safe to store: secrets blanked, sizes bounded, dates as text."""
    if key is not None and is_secret_key(key):
        return REDACTED if value not in (None, "") else value
    if depth > 6:
        return "…"
    if isinstance(value, dict):
        return {str(k)[:60]: redact(v, str(k), depth=depth + 1) for k, v in list(value.items())[:60]}
    if isinstance(value, (list, tuple, set)):
        return [redact(v, depth=depth + 1) for v in list(value)[:50]]
    if isinstance(value, str):
        if _SECRET_VALUE.match(value.strip()):
            return REDACTED
        return value if len(value) <= 500 else value[:500] + "…"
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:200]


def diff(before: Optional[dict], after: Optional[dict], *, keys: Optional[Iterable[str]] = None) -> dict:
    """What changed between two snapshots, as {field: {from, to}}, redacted."""
    before, after = before or {}, after or {}
    fields = list(keys) if keys is not None else sorted(set(before) | set(after))
    changes = {}
    for field in fields:
        old, new = before.get(field), after.get(field)
        if _comparable(old) != _comparable(new):
            if is_secret_key(field):
                changes[field] = {"from": REDACTED, "to": REDACTED}
            else:
                changes[field] = {"from": redact(old, field), "to": redact(new, field)}
    return changes


def _comparable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, float) and value.is_integer():
        return value
    return value


def snapshot(obj: Any, fields: Iterable[str]) -> dict:
    return {field: getattr(obj, field, None) for field in fields}


# ----------------------------------------------------------------- recording


def _actor_fields(actor: Any) -> dict:
    if actor is None:
        return {}
    from app.models import AdminUser, Customer

    if isinstance(actor, AdminUser):
        return {"actor_type": "admin", "actor_id": actor.id, "actor_name": (actor.name or "")[:120],
                "actor_email": (actor.email or "")[:255], "actor_role": (actor.role or "")[:40]}
    if isinstance(actor, Customer):
        return {"actor_type": "customer", "actor_id": actor.id, "actor_name": (actor.full_name or "")[:120],
                "actor_email": (actor.email or "")[:255], "actor_role": ""}
    return {}


def record(
    db: Session,
    action: str,
    *,
    resource_type: str = "",
    resource_id: Any = "",
    summary: str = "",
    changes: Optional[dict] = None,
    details: Optional[dict] = None,
    outcome: str = "success",
    actor: Any = None,
    status_code: Optional[int] = None,
    error_code: str = "",
    system: bool = False,
) -> AuditLog:
    """
    Add an entry to the caller's transaction — it is written when the work it
    describes is committed, and disappears with it on a rollback. Never commits.

    The actor is whoever made the request (from the verified token), unless
    one is passed. `system=True` for work nobody asked for — a background job.
    """
    ctx = _context.get()
    fields = _actor_fields(actor)
    if not fields and not system and ctx is not None:
        fields = _actor_fields(_resolve_actor(db, ctx))
    if not fields:
        fields = {"actor_type": "system" if system or ctx is None else "anonymous"}
    entry = AuditLog(
        occurred_at=datetime.utcnow(),
        action=action[:80],
        resource_type=(resource_type or "")[:40],
        resource_id=str(resource_id or "")[:80],
        summary=(summary or "")[:300],
        outcome=outcome,
        status_code=status_code,
        error_code=(error_code or "")[:60],
        changes=redact(changes) if changes else None,
        details=redact(details) if details else None,
        ip_address=(ctx or {}).get("ip", "")[:64],
        user_agent=(ctx or {}).get("user_agent", "")[:300],
        request_id=(ctx or {}).get("request_id", ""),
        **fields,
    )
    detached = _DETACHED.get()
    if detached is not None:
        detached.append(entry)
        return entry
    db.add(entry)
    if ctx is not None:
        ctx["audited"] = True
    return entry


# Set while `record_now` builds an entry, so `record` hands it back instead of
# adding it to the request's session.
_DETACHED: ContextVar[Optional[list]] = ContextVar("audit_detached", default=None)


def _write_detached(db: Session, entry: AuditLog) -> None:
    """
    Write one entry on its own connection and transaction, leaving the
    request's session exactly as it was — a failed request's half-made
    changes are neither committed nor discarded by the audit trail.
    """
    from sqlalchemy import insert
    from sqlalchemy.engine import Engine

    # Unset fields are left out, so the column defaults apply as they would through the session.
    values = {c.name: getattr(entry, c.key) for c in AuditLog.__table__.columns
              if c.name != "id" and getattr(entry, c.key) is not None}
    statement = insert(AuditLog.__table__).values(**values)
    bind = db.get_bind()
    if isinstance(bind, Engine):
        with bind.begin() as connection:
            connection.execute(statement)
    else:  # already a connection (the test suite's): use it as it is
        bind.execute(statement)


def record_now(db: Session, action: str, **kwargs) -> None:
    """
    `record`, written at once on its own transaction: for an attempt that
    failed (a refused sign-in), whose request will not commit anything.
    """
    collected: list = []
    token = _DETACHED.set(collected)
    try:
        record(db, action, **kwargs)
    finally:
        _DETACHED.reset(token)
    try:
        for entry in collected:
            _write_detached(db, entry)
        ctx = _context.get()
        if ctx is not None:
            ctx["audited_final"] = True
    except Exception:  # the trail must never turn a refusal into a 500
        logger.exception("Could not write the audit entry for %s", action)


# ------------------------------------------------------- per-request capture


def _client_ip(request: Request) -> str:
    from app.dependencies.auth import client_ip

    return client_ip(request)


async def capture(request: Request, db: Session = Depends(get_db)):
    """
    Records any change an administrator makes, and any request an
    administrator was refused. Async on purpose: the request context set here
    is then inherited by the endpoint (which runs in a worker thread), so a
    service deep inside it can add its own detailed entry with `record`.
    """
    ctx = {
        "request_id": secrets.token_hex(8),
        "ip": _client_ip(request),
        "user_agent": request.headers.get("user-agent", ""),
        "authorization": request.headers.get("authorization", ""),
        "audited": False,
    }
    token = _context.set(ctx)
    try:
        yield
    except Exception as error:
        await _after(request, db, ctx, error)
        raise
    else:
        await _after(request, db, ctx, None)
    finally:
        _context.reset(token)


async def _after(request: Request, db: Session, ctx: dict, error: Optional[BaseException]) -> None:
    from starlette.concurrency import run_in_threadpool

    from app.core.errors import AppError

    denied = isinstance(error, AppError) and error.status_code == 403
    if ctx.get("audited_final") or (request.method not in MUTATING and not denied):
        return
    # A detailed entry was added by the service — unless the work failed, in
    # which case it was rolled back with it and the failure is recorded here.
    if error is None and ctx.get("audited"):
        return
    try:
        await run_in_threadpool(_write_generic, request, db, ctx, error)
    except Exception:  # never let the trail break the response
        logger.exception("Could not write the audit entry for %s %s", request.method, request.url.path)


def _resolve_actor(db: Session, ctx: dict):
    """The administrator (or customer) the verified token names, cached for the request."""
    if "actor" in ctx:
        return ctx["actor"]
    actor = None
    header = ctx.get("authorization") or ""
    if header.lower().startswith("bearer "):
        from app.core.security import decode_access_token
        from app.models import AdminUser, Customer

        claims = decode_access_token(header[7:].strip())
        if claims:
            model = AdminUser if claims.get("actor") == "admin" else Customer if claims.get("actor") == "customer" else None
            if model is not None:
                actor = db.get(model, claims.get("sub"))
    ctx["actor"] = actor
    return actor


def _route_parts(request: Request) -> tuple:
    """(resource, verb, record id, summary) from the matched route."""
    route = request.scope.get("route")
    template = getattr(route, "path", request.url.path) or ""
    from app.core.config import settings

    if template.startswith(settings.API_PREFIX):
        template = template[len(settings.API_PREFIX):]
    segments = [s for s in template.strip("/").split("/") if s]
    if segments and segments[0] == "admin":
        segments = segments[1:]
    resource = segments[0] if segments else "portal"
    statics = [s for s in segments[1:] if not s.startswith("{")]
    verbs = {"POST": "create", "PUT": "update", "PATCH": "update", "DELETE": "delete", "GET": "view"}
    verb = statics[-1] if statics else verbs.get(request.method, request.method.lower())
    params = request.path_params or {}
    record_id = next(iter(params.values()), "") if params else ""
    summary = getattr(route, "summary", "") or f"{request.method} {template}"
    return resource, verb.replace("-", "_"), str(record_id), summary


def _write_generic(request: Request, db: Session, ctx: dict, error: Optional[BaseException]) -> None:
    from app.core.errors import AppError
    from app.models import AdminUser

    actor = _resolve_actor(db, ctx)
    path = request.url.path
    is_admin_route = "/admin/" in path
    if not isinstance(actor, AdminUser) and not is_admin_route:
        return  # a customer's own changes are not the portal's audit trail
    if actor is None and error is None:
        return
    resource, verb, record_id, summary = _route_parts(request)
    if isinstance(error, AppError):
        outcome = "denied" if error.status_code in (401, 403) else "failure"
        status_code, error_code = error.status_code, error.error_code
    elif error is not None:
        outcome, status_code, error_code = "failure", 500, "SERVER_ERROR"
    else:
        outcome, status_code, error_code = "success", None, ""
    if actor is None and outcome != "denied":
        return
    record_now(
        db,
        f"{resource}.{verb}",
        resource_type=resource,
        resource_id=record_id,
        summary=summary,
        outcome=outcome,
        status_code=status_code,
        error_code=error_code,
        details={"method": request.method, "path": path[:200]},
        actor=actor,
    )


# ---------------------------------------------------------------- immutable


class AuditLogImmutable(RuntimeError):
    pass


@event.listens_for(Session, "before_flush")
def _refuse_changes(session: Session, flush_context, instances) -> None:
    for obj in session.deleted:
        if isinstance(obj, AuditLog):
            raise AuditLogImmutable("Audit log entries cannot be deleted.")
    for obj in session.dirty:
        if isinstance(obj, AuditLog) and session.is_modified(obj, include_collections=False):
            raise AuditLogImmutable("Audit log entries cannot be changed.")


@event.listens_for(Session, "do_orm_execute")
def _refuse_bulk(state) -> None:
    if not (state.is_update or state.is_delete):
        return
    for mapper in state.all_mappers:
        if mapper.class_ is AuditLog:
            raise AuditLogImmutable("Audit log entries cannot be changed or deleted.")
