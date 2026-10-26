"""
Store-wide try-on settings, in the `try_on` settings document.

    enabled               the switch for the whole feature
    trial                 what customers without a qualifying plan get:
                            {enabled, generations (lifetime), capabilities}
    usageWarningPercent   tell a customer when they've used this much
    retentionReminderDays remind before a temporary result is deleted
    lapsedGraceDays       results kept "permanently" under a membership that
                          has ended are deleted this many days later
    submitPerHour         try-ons one customer may start per hour (abuse limit)
    uploadsPerHour        photos one customer may upload per hour
    feedback              ask customers to rate results
    privacyNotice         shown before a photo is uploaded
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.errors import ValidationError

KEY = "try_on"

DEFAULTS = {
    "enabled": True,
    "trial": {"enabled": False, "generations": 2, "capabilities": []},
    "usageWarningPercent": 80,
    "retentionReminderDays": 3,
    "lapsedGraceDays": 30,
    "submitPerHour": 30,
    "uploadsPerHour": 30,
    "feedback": True,
    "privacyNotice": (
        "Your photo is used only to create your try-on. It is stored privately, never shared or used to "
        "train AI models, and you can delete it at any time."
    ),
}


def _int(value, low: int, high: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(number, high))


def get(db: Session) -> dict:
    from app.models import SettingDocument

    document = db.get(SettingDocument, KEY)
    stored = document.value if document and isinstance(document.value, dict) else {}
    return clean({**DEFAULTS, **stored}, strict=False)


def clean(value: dict, *, strict: bool = True) -> dict:
    if not isinstance(value, dict):
        raise ValidationError("Send the try-on settings as an object.", error_code="INVALID_SETTINGS")
    trial = value.get("trial") if isinstance(value.get("trial"), dict) else {}
    capabilities = trial.get("capabilities") if isinstance(trial.get("capabilities"), list) else []
    notice = value.get("privacyNotice", DEFAULTS["privacyNotice"])
    if not isinstance(notice, str):
        if strict:
            raise ValidationError("The privacy notice must be text.", error_code="INVALID_SETTINGS")
        notice = DEFAULTS["privacyNotice"]
    return {
        "enabled": value.get("enabled", True) is not False,
        "trial": {
            "enabled": trial.get("enabled") is True,
            "generations": _int(trial.get("generations"), 0, 100, 2),
            "capabilities": [str(c)[:60] for c in capabilities if isinstance(c, str)][:20],
        },
        "usageWarningPercent": _int(value.get("usageWarningPercent"), 50, 100, 80),
        "retentionReminderDays": _int(value.get("retentionReminderDays"), 0, 30, 3),
        "lapsedGraceDays": _int(value.get("lapsedGraceDays"), 0, 365, 30),
        "submitPerHour": _int(value.get("submitPerHour"), 1, 1000, 30),
        "uploadsPerHour": _int(value.get("uploadsPerHour"), 1, 1000, 30),
        "feedback": value.get("feedback", True) is not False,
        "privacyNotice": notice.strip()[:1000] or DEFAULTS["privacyNotice"],
    }


def save(db: Session, payload: dict) -> dict:
    from app.models import SettingDocument

    value = clean({**get(db), **(payload if isinstance(payload, dict) else {})})
    document = db.get(SettingDocument, KEY)
    if document is None:
        db.add(SettingDocument(key=KEY, value=value))
    else:
        document.value = value
    return value
