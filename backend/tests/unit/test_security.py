"""
Password hashing and tokens.

The `actor` claim gets the most attention here: it is the only thing stopping a
customer's perfectly valid token from satisfying an administrator's endpoint.
"""

from __future__ import annotations

import pytest

from app.core.security import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)


class TestPasswords:
    def test_a_hash_is_not_the_password(self):
        hashed = hash_password("Customer@123")
        assert hashed != "Customer@123"
        assert "Customer@123" not in hashed

    def test_the_same_password_hashes_differently_each_time(self):
        """Per-hash salt — two accounts with the same password must not match."""
        assert hash_password("Customer@123") != hash_password("Customer@123")

    def test_verifies_the_right_password(self):
        assert verify_password("Customer@123", hash_password("Customer@123"))

    def test_rejects_the_wrong_one(self):
        assert not verify_password("Customer@124", hash_password("Customer@123"))

    def test_rejects_a_hash_that_is_not_one(self):
        """A malformed stored value must fail closed, not raise."""
        assert not verify_password("anything", "not-a-bcrypt-hash")

    def test_refuses_a_password_bcrypt_would_silently_truncate(self):
        """
        bcrypt ignores everything past 72 bytes.

        Accepting a longer one would mean two different passwords that both
        open the account — so it is refused rather than quietly shortened.
        """
        with pytest.raises(ValueError):
            hash_password("a" * 73)


class TestTokens:
    def test_round_trip(self):
        token = create_access_token("CUS001", actor="customer")
        claims = decode_access_token(token)
        assert claims["sub"] == "CUS001"
        assert claims["actor"] == "customer"

    def test_carries_the_role(self):
        token = create_access_token("ADM001", actor="admin", role="super-admin")
        assert decode_access_token(token)["role"] == "super-admin"

    def test_a_customer_token_is_not_an_admin_token(self):
        claims = decode_access_token(create_access_token("CUS001", actor="customer"))
        assert claims["actor"] != "admin"

    def test_rubbish_decodes_to_nothing(self):
        assert decode_access_token("not.a.token") is None

    def test_a_tampered_token_is_rejected(self):
        """
        Flip one character of the payload and the signature no longer matches.

        This is the property the whole scheme rests on: the claims are readable
        by anyone, and editable by no one.
        """
        token = create_access_token("CUS001", actor="customer")
        header, payload, signature = token.split(".")
        edited = payload[:-2] + ("aa" if payload[-2:] != "aa" else "bb")
        assert decode_access_token(f"{header}.{edited}.{signature}") is None

    def test_an_expired_token_is_rejected(self):
        token = create_access_token("CUS001", actor="customer", expires_minutes=-1)
        assert decode_access_token(token) is None
