"""
The test suite's own isolation: guards for leaks that made tests depend on order.

A module imported for the first time while a test has something monkeypatched
binds the fake with `from x import y` and keeps it forever. This happened twice
(a stubbed payment provider that later reached the real gateway, and a fake
email `notify` that later swallowed every invoice email). conftest now imports
the whole `app` package before any test runs; these check that it still does.
"""

from __future__ import annotations

import pkgutil
import sys

import app


def test_every_app_module_is_imported_before_the_tests_run():
    missing = [m.name for m in pkgutil.walk_packages(app.__path__, "app.") if m.name not in sys.modules]
    assert missing == []


def test_name_bound_imports_point_at_the_real_functions():
    """The two bindings that leaked: each must be the real function, not a test's stand-in."""
    from app.services import email, orders, payments
    from app.services.email import notifications

    assert notifications.notify is email.notify
    assert notifications.notify.__module__ == "app.services.email"
    assert orders.get_provider is payments.get_provider
