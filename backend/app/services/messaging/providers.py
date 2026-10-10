"""
The companies that carry SMS and WhatsApp messages.

Business logic never talks to a provider directly: it asks for the channel's
provider (`sms()`, `whatsapp()`) and calls `send`. Which provider that is,
and its credentials, come from the environment (see `core.config`) — so a
provider can be switched without touching anything that sends messages.

A channel with no provider configured returns `Unconfigured`, which refuses
every send with a clear reason. Nothing is ever reported as sent that wasn't.

## Errors

`ProviderError.transient` says whether trying again might work: a timeout, a
rate limit or a 5xx is transient; a malformed number or a rejected template
is not. The delivery queue retries the first kind with backoff and gives up on
the second straight away.
"""

from __future__ import annotations

import base64
import ipaddress
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import List, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)
TIMEOUT_SECONDS = 10


class ProviderError(Exception):
    def __init__(self, message: str, *, transient: bool):
        super().__init__(message)
        self.transient = transient


@dataclass
class SendResult:
    message_id: str
    status: str = "sent"


@dataclass
class Message:
    """What goes out. SMS uses `text`; WhatsApp uses `template` and `variables` (or `text` in a session)."""

    to: str
    text: str = ""
    template: str = ""
    language: str = "en"
    variables: Optional[List[str]] = None


class Provider:
    name = "none"
    channel = ""
    # WhatsApp only: whether a message with no approved template may go as plain
    # text (a "session" message, delivered within 24 hours of the customer's
    # last message to the sender).
    plain_text_whatsapp = False

    def configured(self) -> tuple:
        """(ready, reason it isn't)."""
        return False, "Not configured."

    def send(self, message: Message) -> SendResult:  # pragma: no cover — overridden
        raise ProviderError("Not configured.", transient=False)

    def describe(self) -> dict:
        ready, reason = self.configured()
        return {"provider": self.name, "configured": ready, "reason": "" if ready else reason}


class Unconfigured(Provider):
    def __init__(self, channel: str, reason: str):
        self.channel = channel
        self._reason = reason

    def configured(self) -> tuple:
        return False, self._reason

    def send(self, message: Message) -> SendResult:
        raise ProviderError(self._reason, transient=False)


def _http(method: str, url: str, *, data: Optional[bytes], headers: dict) -> dict:
    """One request. Credentials go in headers only; errors never include them."""
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 — fixed https hosts
            body = response.read().decode("utf-8", "replace")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            detail = {}
        message = (detail.get("message") or (detail.get("error") or {}).get("message") or f"HTTP {error.code}")
        transient = error.code in (408, 425, 429) or error.code >= 500
        raise ProviderError(f"{message} (HTTP {error.code})"[:300], transient=transient) from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ProviderError(f"Couldn't reach the provider: {type(error).__name__}", transient=True) from None


# ------------------------------------------------------------------ Twilio


class TwilioSms(Provider):
    name = "twilio"
    channel = "sms"

    def __init__(self, account_sid: str, auth_token: str, sender: str):
        self.sid, self.token, self.sender = account_sid, auth_token, sender

    def configured(self) -> tuple:
        if not (self.sid and self.token):
            return False, "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not set."
        if not self.sender:
            return False, "NOTIFICATION_SMS_SENDER (a Twilio number or Messaging Service SID) is not set."
        return True, ""

    def _auth(self) -> str:
        return "Basic " + base64.b64encode(f"{self.sid}:{self.token}".encode()).decode()

    def _post(self, fields: dict) -> SendResult:
        ready, reason = self.configured()
        if not ready:
            raise ProviderError(reason, transient=False)
        url = f"https://api.twilio.com/2010-04-01/Accounts/{urllib.parse.quote(self.sid)}/Messages.json"
        callback = status_callback_url("twilio")
        if callback:
            fields["StatusCallback"] = callback
        body = _http("POST", url, data=urllib.parse.urlencode(fields).encode(),
                     headers={"Authorization": self._auth(), "Content-Type": "application/x-www-form-urlencoded"})
        if not body.get("sid"):
            raise ProviderError("Twilio didn't return a message id.", transient=True)
        return SendResult(message_id=body["sid"], status="sent")

    def send(self, message: Message) -> SendResult:
        fields = {"To": message.to, "Body": message.text[:1600]}
        fields["MessagingServiceSid" if self.sender.startswith("MG") else "From"] = self.sender
        return self._post(fields)


class TwilioWhatsApp(TwilioSms):
    """
    WhatsApp through Twilio: an approved Content template (HX…) with numbered
    variables, or plain text when the notification has no template. The Twilio
    Sandbox can't use the store's own templates, so plain text is how it sends;
    it reaches numbers that have joined the sandbox and messaged it in the last
    24 hours.
    """

    channel = "whatsapp"
    plain_text_whatsapp = True

    def configured(self) -> tuple:
        if not (self.sid and self.token):
            return False, "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not set."
        if not self.sender:
            return False, "NOTIFICATION_WHATSAPP_SENDER (e.g. whatsapp:+14155238886) is not set."
        return True, ""

    def send(self, message: Message) -> SendResult:
        sender = self.sender if self.sender.startswith("whatsapp:") else f"whatsapp:{self.sender}"
        fields = {"To": f"whatsapp:{message.to}", "From": sender}
        if message.template:
            fields["ContentSid"] = message.template
            fields["ContentVariables"] = json.dumps({str(i + 1): v for i, v in enumerate(message.variables or [])})
        else:
            fields["Body"] = message.text[:1600]
        return self._post(fields)


# ------------------------------------------------------------ Meta (Cloud)


class MetaWhatsApp(Provider):
    """WhatsApp Business Platform (Cloud API): template messages by name and language."""

    name = "meta"
    channel = "whatsapp"

    def __init__(self, token: str, phone_number_id: str, version: str):
        self.token, self.phone_id, self.version = token, phone_number_id, version or "v20.0"

    def configured(self) -> tuple:
        if not (self.token and self.phone_id):
            return False, "WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are not set."
        return True, ""

    def send(self, message: Message) -> SendResult:
        ready, reason = self.configured()
        if not ready:
            raise ProviderError(reason, transient=False)
        to = message.to.lstrip("+")
        if message.template:
            payload = {
                "messaging_product": "whatsapp", "to": to, "type": "template",
                "template": {
                    "name": message.template, "language": {"code": message.language or "en"},
                    "components": [{"type": "body", "parameters": [
                        {"type": "text", "text": str(v)[:1000]} for v in (message.variables or [])]}]
                    if message.variables else [],
                },
            }
        else:
            payload = {"messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": message.text[:4096]}}
        url = f"https://graph.facebook.com/{self.version}/{urllib.parse.quote(self.phone_id)}/messages"
        body = _http("POST", url, data=json.dumps(payload).encode(),
                     headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        messages = body.get("messages") or []
        if not messages or not messages[0].get("id"):
            raise ProviderError("WhatsApp didn't return a message id.", transient=True)
        return SendResult(message_id=messages[0]["id"], status="sent")


# ---------------------------------------------------------------- factory


def _publicly_reachable(url: str) -> bool:
    """False for localhost and private addresses: Twilio refuses those (HTTP 400) and the whole send fails."""
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if not host or host == "localhost" or host.endswith(".localhost") or "." not in host and ":" not in host:
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return True
    return address.is_global


def status_callback_url(provider: str) -> str:
    """Where a provider reports delivery. Needs the API's public address; empty in local development."""
    base = (settings.PUBLIC_API_URL or "").rstrip("/")
    if not base or not _publicly_reachable(base):
        return ""
    return f"{base}{settings.API_PREFIX}/notifications/webhooks/{provider}"


def sms() -> Provider:
    name = (settings.NOTIFICATION_SMS_PROVIDER or "none").lower()
    if name == "twilio":
        return TwilioSms(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN, settings.NOTIFICATION_SMS_SENDER)
    if name in ("", "none"):
        return Unconfigured("sms", "No SMS provider is set (NOTIFICATION_SMS_PROVIDER).")
    return Unconfigured("sms", f"Unknown SMS provider '{name}'.")


def whatsapp() -> Provider:
    name = (settings.NOTIFICATION_WHATSAPP_PROVIDER or "none").lower()
    if name == "meta":
        return MetaWhatsApp(settings.WHATSAPP_ACCESS_TOKEN, settings.WHATSAPP_PHONE_NUMBER_ID,
                            settings.WHATSAPP_API_VERSION)
    if name == "twilio":
        return TwilioWhatsApp(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN,
                              settings.NOTIFICATION_WHATSAPP_SENDER)
    if name in ("", "none"):
        return Unconfigured("whatsapp", "No WhatsApp provider is set (NOTIFICATION_WHATSAPP_PROVIDER).")
    return Unconfigured("whatsapp", f"Unknown WhatsApp provider '{name}'.")


def for_channel(channel: str) -> Provider:
    if channel == "sms":
        return sms()
    if channel == "whatsapp":
        return whatsapp()
    raise ValueError(channel)
