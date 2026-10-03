"""Which sign-in providers exist, built from the environment."""

from __future__ import annotations

from typing import Callable, Dict, List, Optional

from app.services.identity.apple import Apple
from app.services.identity.base import IdentityProvider
from app.services.identity.google import Google
from app.services.identity.microsoft import Microsoft

# code -> factory. Facebook is the next one to add (see docs/authentication.md).
PROVIDERS: Dict[str, Callable[[], IdentityProvider]] = {
    "google": Google,
    "apple": Apple,
    "microsoft": Microsoft,
}

LABELS = {"google": "Google", "apple": "Apple", "microsoft": "Microsoft", "phone": "Mobile number"}


def get(code: str) -> Optional[IdentityProvider]:
    factory = PROVIDERS.get((code or "").lower())
    return factory() if factory else None


def codes() -> List[str]:
    return list(PROVIDERS)
