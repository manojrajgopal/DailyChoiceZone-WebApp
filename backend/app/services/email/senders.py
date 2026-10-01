"""
How mail leaves: Gmail (Google OAuth 2.0) or any SMTP server.

Each sender takes a finished message and delivers it, or raises `SendError`
with a message written for the person configuring it — never a stack trace,
never a secret.

Gmail
    Sends through the Gmail API (`users.messages.send`) as the account that
    granted the refresh token. The access token is refreshed from the refresh
    token when it is missing or expired, and kept in memory for its lifetime.
    The OAuth app needs the `https://www.googleapis.com/auth/gmail.send` scope.

SMTP
    Host, port, username, password and `ssl` / `starttls` / `none`.
"""

from __future__ import annotations

import base64
import smtplib
import ssl
import time
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Dict, Optional, Tuple

import httpx

TOKEN_URL = "https://oauth2.googleapis.com/token"
SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send"
# Read access, so bounce notices in the sending mailbox can be matched to the
# emails they report on (see `services/email/bounces.py`).
GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"

# access token cache: refresh token → (token, expires at)
_tokens: Dict[str, Tuple[str, float]] = {}


class SendError(Exception):
    """A delivery failure, described for whoever set the account up."""


def build_message(
    *, sender_email: str, sender_name: str, reply_to: str, to: str, subject: str, html: str, text: str
) -> EmailMessage:
    message = EmailMessage()
    message["From"] = formataddr((sender_name, sender_email)) if sender_name else sender_email
    message["To"] = to
    message["Subject"] = subject
    message["Message-ID"] = make_msgid(domain=(sender_email.split("@")[-1] or "localhost"))
    if reply_to:
        message["Reply-To"] = reply_to
    from app.services.email.templates import LOGO_CID, embed_logo

    html, logo = embed_logo(html)
    message.set_content(text or " ")
    message.add_alternative(html, subtype="html")
    if logo:
        message.get_payload()[1].add_related(logo, "image", "png", cid=f"<{LOGO_CID}>", filename="logo.png")
    return message


# ------------------------------------------------------------------- Gmail


def _google_error(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        body = {}
    code = body.get("error")
    if isinstance(code, dict):
        status = code.get("status") or ""
        message = code.get("message") or ""
        if response.status_code == 403 or status == "PERMISSION_DENIED":
            return (
                "Google refused to send from this account. Make sure the refresh token was granted "
                "the Gmail send permission (gmail.send) and that the Gmail API is enabled for the project."
            )
        return f"Google refused the message: {message}"[:300]
    if code == "invalid_grant":
        return "Google rejected the refresh token — it may have expired or been revoked. Connect the account again."
    if code == "invalid_client":
        return "Google didn't accept the client ID or client secret."
    if code == "unauthorized_client":
        return "This OAuth client isn't allowed to use that refresh token."
    return (body.get("error_description") or f"Google answered {response.status_code}.")[:300]


def gmail_access_token(credentials: dict, *, force: bool = False) -> str:
    refresh = credentials.get("refreshToken") or ""
    cached = _tokens.get(refresh)
    if cached and not force and cached[1] > time.time() + 60:
        return cached[0]
    given = credentials.get("accessToken") or ""
    if given and not force and not refresh:
        return given
    if not (credentials.get("clientId") and credentials.get("clientSecret") and refresh):
        if given:
            return given
        raise SendError("Enter the client ID, client secret and refresh token.")
    try:
        response = httpx.post(
            TOKEN_URL,
            data={
                "client_id": credentials["clientId"],
                "client_secret": credentials["clientSecret"],
                "refresh_token": refresh,
                "grant_type": "refresh_token",
            },
            timeout=15,
        )
    except httpx.HTTPError:
        raise SendError("Couldn't reach Google to refresh the access token. Please try again.") from None
    if response.status_code != 200:
        raise SendError(_google_error(response))
    body = response.json()
    token = body.get("access_token") or ""
    _tokens[refresh] = (token, time.time() + int(body.get("expires_in") or 3000))
    return token


def send_gmail(credentials: dict, message: EmailMessage) -> str:
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
    for attempt in (0, 1):
        token = gmail_access_token(credentials, force=attempt == 1)
        try:
            response = httpx.post(
                SEND_URL,
                headers={"Authorization": f"Bearer {token}"},
                json={"raw": raw},
                timeout=20,
            )
        except httpx.HTTPError:
            raise SendError("Couldn't reach Gmail. Please try again.") from None
        if response.status_code == 401 and attempt == 0:
            continue  # the access token expired: refresh once and retry
        if response.status_code not in (200, 202):
            raise SendError(_google_error(response))
        return (response.json() or {}).get("id", "")
    raise SendError("Google didn't accept the access token.")


def exchange_code(*, client_id: str, client_secret: str, code: str, redirect_uri: str) -> dict:
    """The OAuth consent step's final hop: a one-time code for tokens."""
    try:
        response = httpx.post(
            TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
            timeout=15,
        )
    except httpx.HTTPError:
        raise SendError("Couldn't reach Google. Please try again.") from None
    if response.status_code != 200:
        raise SendError(_google_error(response))
    body = response.json()
    if not body.get("refresh_token"):
        raise SendError(
            "Google didn't return a refresh token. Remove the app's access from your Google account "
            "and connect again, so Google asks for consent afresh."
        )
    return {"refreshToken": body["refresh_token"], "accessToken": body.get("access_token", "")}


# -------------------------------------------------------------------- SMTP


def send_smtp(credentials: dict, message: EmailMessage) -> str:
    host = credentials.get("host") or ""
    port = int(credentials.get("port") or 587)
    security = credentials.get("security") or "starttls"
    if not host:
        raise SendError("Enter the SMTP server address.")
    try:
        if security == "ssl":
            server = smtplib.SMTP_SSL(host, port, timeout=20, context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(host, port, timeout=20)
        with server:
            if security == "starttls":
                server.starttls(context=ssl.create_default_context())
            if credentials.get("username"):
                server.login(credentials["username"], credentials.get("password") or "")
            server.send_message(message)
    except smtplib.SMTPAuthenticationError:
        raise SendError("The SMTP server rejected the username or password.") from None
    except (smtplib.SMTPException, OSError) as error:
        raise SendError(f"The SMTP server couldn't send the message ({error.__class__.__name__}).") from None
    return message["Message-ID"] or ""


# ------------------------------------------------------------ deliverability

# Per domain: (reason it can't receive mail, or "" when it can; checked at).
_domains: Dict[str, Tuple[str, float]] = {}
_DOMAIN_TTL = 6 * 3600


def undeliverable(address: str) -> str:
    """Why `address` can't receive email, or "" when it can — see `check_domain`."""
    return check_domain(address)


def check_domain(address: str) -> str:
    """
    Why `address` can't receive email, or "" when it can (or we can't tell).

    Gmail and most SMTP servers *accept* a message for a domain that doesn't
    exist and bounce it later to the sending mailbox — so the log said "Sent"
    for mail that went nowhere. A domain with no mail server (no MX record, no
    address record, or a "null MX") is refused here instead, with the reason,
    so the email history shows the real outcome. A DNS failure on our side is
    not held against the address: only a definite answer blocks a send.
    """
    import dns.exception
    import dns.resolver

    domain = (address or "").rsplit("@", 1)[-1].strip().lower().rstrip(".")
    if not domain:
        return "The email address has no domain."
    cached = _domains.get(domain)
    if cached and time.time() - cached[1] < _DOMAIN_TTL:
        return cached[0]

    reason = ""
    resolver = dns.resolver.Resolver()
    resolver.lifetime = 5.0
    try:
        answers = resolver.resolve(domain, "MX")
        hosts = [str(record.exchange).rstrip(".") for record in answers]
        if hosts and all(host in ("", ".") for host in hosts):
            reason = f"{domain} doesn't accept email (it publishes a null MX record)."
    except dns.resolver.NXDOMAIN:
        reason = f"The domain {domain} doesn't exist, so this address can't receive email."
    except dns.resolver.NoAnswer:
        # No MX: mail falls back to the domain's own address record, if any.
        try:
            resolver.resolve(domain, "A")
        except dns.resolver.NoAnswer:
            try:
                resolver.resolve(domain, "AAAA")
            except dns.resolver.NoAnswer:
                reason = f"{domain} has no mail server, so this address can't receive email."
            except dns.exception.DNSException:
                reason = ""
        except dns.exception.DNSException:
            reason = ""
    except dns.exception.DNSException:
        # A timeout or resolver problem here says nothing about the address.
        return ""
    _domains[domain] = (reason, time.time())
    return reason


def deliver(provider: str, credentials: dict, message: EmailMessage) -> str:
    reason = undeliverable(str(message.get("To", "")))
    if reason:
        raise SendError(reason)
    if provider == "gmail-oauth":
        return send_gmail(credentials, message)
    if provider == "smtp":
        return send_smtp(credentials, message)
    raise SendError("Choose how emails are sent.")


def consent_url(*, client_id: str, redirect_uri: str, state: str, login_hint: Optional[str] = None) -> str:
    from urllib.parse import urlencode

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": f"{GMAIL_SCOPE} {GMAIL_READ_SCOPE}",
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    }
    if login_hint:
        params["login_hint"] = login_hint
    return f"{AUTH_URL}?{urlencode(params)}"
