"""
Who carries a one-time code to the customer.

SMS (`OTP_SMS_PROVIDER`):

- `console`: **development only.** Nothing is sent; the code is written to the
  server log at DEBUG level so a developer can sign in without an SMS
  account. It refuses to send (and reports itself unconfigured) when
  `ENVIRONMENT=production`, so a misconfigured live store fails loudly rather
  than printing customers' codes to a log.
- `twilio`: Twilio's Messaging API, through `messaging.providers.TwilioSms`
  and the `TWILIO_*` credentials. The sender is `OTP_SENDER_ID` or, when that
  is empty, `NOTIFICATION_SMS_SENDER`.
- `msg91`: MSG91's flow API with a DLT-approved template whose variable is
  `##otp##` (`MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`, `OTP_SENDER_ID`).
- `none`: mobile codes are off.

Email codes go through the store's email account (Settings → Email) as the
`account_security` type, which can't be opted out of, isn't put in the bell,
and whose content is never kept for a retry (`SECRET_EMAIL_TYPES`). With no
email account, development falls back to the console.

A code is never stored, queued or logged anywhere else. Codes are not sent
through the notification queue (which keeps message text for retries).
"""

from __future__ import annotations

import html as html_lib
import logging
from typing import Optional

import httpx

from app.core.config import settings
from app.services.messaging.providers import Message, Provider, ProviderError, TwilioSms, Unconfigured

logger = logging.getLogger(__name__)

# The tests set an httpx.MockTransport here; the application leaves it None.
TRANSPORT: Optional[httpx.BaseTransport] = None
MSG91_URL = "https://control.msg91.com/api/v5/flow/"

PURPOSE_WORDS = {
    "login": "sign in",
    "login-email": "sign in",
    "verify-phone": "confirm your mobile number",
    "change-phone": "confirm your new mobile number",
    "verify-email": "confirm your email address",
    "sensitive-action": "confirm it's you",
}


def sms_text(code: str, purpose: str, minutes: int) -> str:
    action = PURPOSE_WORDS.get(purpose, "continue")
    return (f"{code} is your Daily Choice Zone code to {action}. It expires in {minutes} minutes. "
            "Never share it with anyone, including our staff.")


class ConsoleSms(Provider):
    """Development only: the code goes to the server log, at DEBUG level."""

    name = "console"
    channel = "sms"

    def configured(self) -> tuple:
        if settings.is_production:
            return False, "The console provider is for development only; set OTP_SMS_PROVIDER for production."
        return True, ""

    def send(self, message: Message) -> object:
        if settings.is_production:
            raise ProviderError("The console provider is for development only.", transient=False)
        # The masked number at INFO, the code itself only at DEBUG, and only outside production.
        from app.services.messaging.service import mask

        logger.info("Development SMS code sent to %s (console provider)", mask(message.to))
        logger.debug("Development SMS for %s: %s", mask(message.to), message.text)
        return type("Sent", (), {"message_id": "console"})()


class TwilioOtp(TwilioSms):
    def __init__(self):
        super().__init__(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN,
                         settings.OTP_SENDER_ID or settings.NOTIFICATION_SMS_SENDER)


class Msg91(Provider):
    """MSG91 flow API: a DLT template with the code as `##otp##`."""

    name = "msg91"
    channel = "sms"

    def configured(self) -> tuple:
        if not (settings.MSG91_AUTH_KEY and settings.MSG91_TEMPLATE_ID):
            return False, "MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are not set."
        return True, ""

    def send(self, message: Message) -> object:
        ready, reason = self.configured()
        if not ready:
            raise ProviderError(reason, transient=False)
        code = message.variables[0] if message.variables else ""
        body = {"template_id": settings.MSG91_TEMPLATE_ID, "short_url": "0",
                "recipients": [{"mobiles": message.to.lstrip("+"), "otp": code}]}
        if settings.OTP_SENDER_ID:
            body["sender"] = settings.OTP_SENDER_ID
        try:
            kwargs = {"timeout": 10.0}
            if TRANSPORT is not None:
                kwargs["transport"] = TRANSPORT
            with httpx.Client(**kwargs) as http:
                response = http.post(MSG91_URL, json=body,
                                     headers={"authkey": settings.MSG91_AUTH_KEY, "Accept": "application/json"})
        except httpx.HTTPError as error:
            raise ProviderError(f"Couldn't reach MSG91: {type(error).__name__}", transient=True) from None
        try:
            answer = response.json()
        except ValueError:
            answer = {}
        if response.status_code >= 400 or str(answer.get("type", "")).lower() == "error":
            transient = response.status_code >= 500 or response.status_code == 429
            raise ProviderError(f"MSG91 refused the message (HTTP {response.status_code})", transient=transient)
        return type("Sent", (), {"message_id": str(answer.get("message") or "msg91")[:60]})()


def sms_provider() -> Provider:
    name = (settings.OTP_SMS_PROVIDER or "none").strip().lower()
    if name == "console":
        return ConsoleSms()
    if name == "twilio":
        return TwilioOtp()
    if name == "msg91":
        return Msg91()
    if name in ("", "none"):
        return Unconfigured("sms", "No SMS provider is set for codes (OTP_SMS_PROVIDER).")
    return Unconfigured("sms", f"Unknown OTP_SMS_PROVIDER '{name}'.")


def send_sms(to: str, code: str, purpose: str, minutes: int) -> str:
    """Send the code; returns the provider's name. Raises ProviderError."""
    provider = sms_provider()
    ready, reason = provider.configured()
    if not ready:
        raise ProviderError(reason, transient=False)
    provider.send(Message(to=to, text=sms_text(code, purpose, minutes), variables=[code]))
    return provider.name


def email_ready(db) -> tuple:
    from app.services import email as email_service

    if email_service.active_account(db) is not None:
        return True, ""
    if not settings.is_production:
        return True, ""  # development: the console fallback
    return False, "No email account is set up (Settings → Email)."


def send_email(db, to: str, code: str, purpose: str, minutes: int) -> str:
    """
    Queue the code's email on this transaction (it leaves when the caller
    commits). The code is in the body only: never the subject, which the email
    log keeps.
    """
    from app.services import email as email_service

    if email_service.active_account(db) is None:
        if settings.is_production:
            raise ProviderError("No email account is set up.", transient=False)
        from app.services.messaging.service import mask

        logger.info("Development email code for %s (no email account: console)", mask(to))
        logger.debug("Development email code for %s: %s", mask(to), code)
        return "console"
    action = PURPOSE_WORDS.get(purpose, "continue")
    html = email_service.layout(
        "Your one-time code",
        f"Use this code to {html_lib.escape(action)}. It works once, for the next {minutes} minutes.",
        rows=(f'<p style="font-size:28px;letter-spacing:6px;font-weight:600;margin:16px 0">'
              f"{html_lib.escape(code)}</p>"),
        footnote="Never share this code with anyone, including our staff. If you didn't ask for it, ignore "
                 "this email; nothing changes without the code.",
    )
    queued = email_service.notify(
        db, "account_security", to=to, customer_id=None, subject="Your Daily Choice Zone code",
        html=html, text=f"Your Daily Choice Zone code is {code}. It expires in {minutes} minutes. "
                        "Never share it with anyone.",
        reference="otp", inbox=False,
    )
    if not queued:
        raise ProviderError("The code email couldn't be queued.", transient=False)
    return "email"
