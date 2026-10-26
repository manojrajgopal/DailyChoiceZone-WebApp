"""
Virtual try-on, end to end: customer → entitlement → queue → provider →
storage → history, and the store's side (docs/virtual-try-on.md).

Providers are the offline mock adapter (or a fake gradio client); no test
spends credits or reaches the internet.
"""

from __future__ import annotations

import io
from datetime import datetime, timedelta

import pytest
from PIL import Image
from sqlalchemy import select

from app.core.config import settings
from tests.integration.try_on_helpers import (  # noqa: F401
    ephemeral,
    garments,
    make_member,
    make_plan,
    photo_bytes,
    run_queue,
    s3,
    start,
    upload,
    vto,
)

pytestmark = pytest.mark.integration

SECRET = "hf_TestSecretToken1234567890abcd"


@pytest.fixture()
def member(vto, customer, ephemeral):
    make_plan(vto)
    return make_member(vto)


def _photo(client, auth, **form):
    response = upload(client, auth, **form)
    assert response.status_code == 201, response.text
    return response.json()["data"]["id"]


def _usage(db, request_id):
    from app.models import VtoUsage

    return db.execute(select(VtoUsage).where(VtoUsage.request_id == request_id)).scalar_one()


# ------------------------------------------------------------- eligibility


class TestEligibility:
    def test_a_customer_without_a_qualifying_plan_is_refused(self, client, auth, vto, ephemeral):
        data = client.get("/api/try-on/eligibility", headers=auth).json()["data"]
        assert data["eligible"] is False and data["reason"] == "plan_ineligible"
        response = upload(client, auth)
        assert response.status_code == 403
        assert response.json()["error_code"] == "TRY_ON_PLAN_INELIGIBLE"

    def test_a_member_whose_plan_includes_it_is_eligible(self, client, auth, member):
        data = client.get("/api/try-on/eligibility", headers=auth).json()["data"]
        assert data["eligible"] is True and data["source"] == "plan"
        assert data["perPeriod"] == 3 and data["remaining"] == 3 and data["resetsAt"]
        assert data["retention"] == "ephemeral"  # no S3 configured: nothing is kept

    def test_a_plan_without_try_on_does_not_qualify(self, client, auth, vto, customer, ephemeral):
        make_plan(vto, enabled=False)
        make_member(vto)
        assert client.get("/api/try-on/eligibility", headers=auth).json()["data"]["eligible"] is False

    def test_members_who_bought_before_the_plan_had_try_on_get_it(self, client, auth, vto, customer, ephemeral):
        make_plan(vto)
        make_member(vto, snapshot=False)
        assert client.get("/api/try-on/eligibility", headers=auth).json()["data"]["eligible"] is True

    def test_an_expired_membership_does_not_qualify(self, client, auth, member, vto):
        member.ends_at = datetime.utcnow() - timedelta(days=1)
        vto.commit()
        assert client.get("/api/try-on/eligibility", headers=auth).json()["data"]["eligible"] is False

    def test_the_trial_lets_non_members_try_a_few(self, client, auth, vto, customer, ephemeral):
        from app.services.try_on import programme

        programme.save(vto, {"trial": {"enabled": True, "generations": 1}})
        vto.commit()
        data = client.get("/api/try-on/eligibility", headers=auth).json()["data"]
        assert data["eligible"] and data["source"] == "trial" and data["remaining"] == 1
        photo = _photo(client, auth)
        assert start(client, auth, photo).status_code == 202
        run_queue(vto)
        response = start(client, auth, photo)
        assert response.status_code == 429 and response.json()["error_code"] == "TRY_ON_LIMIT_REACHED"

    def test_the_feature_switch_turns_it_off(self, client, auth, member, vto):
        from app.services.try_on import programme

        programme.save(vto, {"enabled": False})
        vto.commit()
        assert upload(client, auth).status_code == 403
        assert client.get("/api/try-on/catalogue").json()["data"]["enabled"] is False


# ----------------------------------------------------------------- the flow


class TestTheFlow:
    def test_upload_request_generate_view_and_delete(self, client, auth, member, vto):
        from app.models import CustomerNotification

        photo = _photo(client, auth)
        response = start(client, auth, photo, color="", size="")
        assert response.status_code == 202, response.text
        request = response.json()["data"]
        assert request["status"] == "queued" and request["canCancel"]

        assert run_queue(vto) == 1
        done = client.get(f"/api/try-on/requests/{request['id']}", headers=auth).json()["data"]
        assert done["status"] == "succeeded"
        assert done["result"]["available"] and done["result"]["mode"] == "ephemeral"
        assert done["original"]["available"]
        assert "credential" not in str(done).lower()

        image = client.get(f"/api/try-on/requests/{request['id']}/image", headers=auth)
        assert image.status_code == 200 and image.headers["content-type"] == "image/jpeg"
        assert image.headers["cache-control"] == "private, no-store"
        assert Image.open(io.BytesIO(image.content)).size == (600, 800)
        assert client.get(f"/api/try-on/requests/{request['id']}/image?which=original", headers=auth).status_code == 200

        assert _usage(vto, request["id"]).status == "consumed"
        usage = client.get("/api/try-on/usage", headers=auth).json()["data"]
        assert usage["usedThisPeriod"] == 1 and usage["remaining"] == 2
        assert vto.execute(select(CustomerNotification).where(
            CustomerNotification.customer_id == "CUS001", CustomerNotification.kind == "try-on")).first()

        history = client.get("/api/try-on/requests", headers=auth).json()["data"]
        assert [r["id"] for r in history["items"]] == [request["id"]]

        assert client.delete(f"/api/try-on/requests/{request['id']}", headers=auth).json()["data"]["pending"] is False
        assert client.get(f"/api/try-on/requests/{request['id']}", headers=auth).status_code == 404
        assert client.get(f"/api/try-on/requests/{request['id']}/image", headers=auth).status_code == 404

    def test_nothing_is_written_outside_the_ephemeral_folder(self, client, auth, member, vto, ephemeral):
        photo = _photo(client, auth)
        start(client, auth, photo)
        run_queue(vto)
        files = [p for p in ephemeral.rglob("*") if p.is_file()]
        assert len(files) == 2  # the photo and the result, both encrypted
        assert all(not f.read_bytes().startswith(b"\xff\xd8") for f in files)

    def test_the_same_key_never_charges_twice(self, client, auth, member, vto):
        from app.models import VtoRequest, VtoUsage

        photo = _photo(client, auth)
        first = start(client, auth, photo, key="press-0001-abcdef")
        second = start(client, auth, photo, key="press-0001-abcdef")
        assert first.json()["data"]["id"] == second.json()["data"]["id"]
        assert second.json()["message"] == "Already started."
        assert len(vto.execute(select(VtoRequest)).scalars().all()) == 1
        assert len(vto.execute(select(VtoUsage)).scalars().all()) == 1

    def test_unsupported_and_coming_soon_items_are_refused(self, client, auth, member, vto):
        from app.models import VtoCategoryMapping

        photo = _photo(client, auth)
        response = start(client, auth, photo, product_id="PRD003")  # Electronics: unmapped
        assert response.status_code == 422 and response.json()["error_code"] == "TRY_ON_UNSUPPORTED_CATEGORY"
        vto.add(VtoCategoryMapping(category_id="CAT002", subcategory="", capability_key="wrist.watch", enabled=True,
                                   created_at=datetime.utcnow(), updated_at=datetime.utcnow()))
        vto.commit()
        response = start(client, auth, photo, product_id="PRD003")
        assert "coming soon" in response.json()["message"]
        offer = client.get("/api/try-on/products/PRD003", headers=auth).json()["data"]
        assert offer["state"] == "coming_soon"

    def test_lower_body_items_never_reach_an_upper_body_model(self, client, auth, member, vto):
        from app.models import VtoProductSetting

        vto.add(VtoProductSetting(product_id="PRD002", capability_key="garment.lower_body", opt_out=False,
                                  garment_image_url="", created_at=datetime.utcnow(), updated_at=datetime.utcnow()))
        vto.commit()
        assert client.get("/api/try-on/products/PRD002", headers=auth).json()["data"]["state"] == "unsupported"
        response = start(client, auth, _photo(client, auth))
        assert response.status_code == 422

    def test_a_draft_product_is_not_found(self, client, auth, member):
        assert start(client, auth, _photo(client, auth), product_id="PRD004").status_code == 404

    def test_a_colour_the_product_does_not_have_is_refused(self, client, auth, member, vto):
        from app.models import ProductColor

        vto.add(ProductColor(product_id="PRD002", name="Blue", hex="#0000ff", position=0))
        vto.commit()
        response = start(client, auth, _photo(client, auth), color="Purple")
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_COLOR"
        assert start(client, auth, _photo(client, auth), color="blue").status_code == 202


# ---------------------------------------------------------- limits and quota


class TestLimits:
    def test_the_period_limit(self, client, auth, vto, customer, ephemeral):
        make_plan(vto, perPeriod=1)
        make_member(vto)
        photo = _photo(client, auth)
        start(client, auth, photo)
        run_queue(vto)
        response = start(client, auth, photo)
        assert response.status_code == 429 and response.json()["error_code"] == "TRY_ON_LIMIT_REACHED"

    def test_failures_do_not_use_the_allowance(self, client, auth, vto, customer, ephemeral):
        from app.models import VtoModel

        make_plan(vto, perPeriod=1, retriesPerRequest=0)
        make_member(vto)
        vto.get(VtoModel, "VMD900").config = {"fail": "provider_unavailable"}
        vto.commit()
        photo = _photo(client, auth)
        failed = start(client, auth, photo).json()["data"]
        run_queue(vto)
        body = client.get(f"/api/try-on/requests/{failed['id']}", headers=auth).json()["data"]
        assert body["status"] == "failed"
        assert body["error"]["message"] == "The try-on service is temporarily unavailable. Please try again later."
        assert _usage(vto, failed["id"]).status == "released"
        vto.get(VtoModel, "VMD900").config = {}
        vto.commit()
        assert start(client, auth, photo).status_code == 202

    def test_one_at_a_time_when_the_plan_says_so(self, client, auth, member):
        photo = _photo(client, auth)
        assert start(client, auth, photo).status_code == 202
        response = start(client, auth, photo)
        assert response.status_code == 429 and response.json()["error_code"] == "TRY_ON_CONCURRENCY_LIMIT"

    def test_the_daily_limit(self, client, auth, vto, customer, ephemeral):
        make_plan(vto, perPeriod=10, perDay=1)
        make_member(vto)
        photo = _photo(client, auth)
        start(client, auth, photo)
        run_queue(vto)
        assert start(client, auth, photo).status_code == 429

    def test_retry_is_limited_by_the_plan(self, client, auth, vto, customer, ephemeral):
        from app.models import VtoModel

        make_plan(vto, retriesPerRequest=1)
        make_member(vto)
        vto.get(VtoModel, "VMD900").config = {"fail": "timeout"}
        vto.commit()
        request = start(client, auth, _photo(client, auth)).json()["data"]
        run_queue(vto)
        assert client.get(f"/api/try-on/requests/{request['id']}", headers=auth).json()["data"]["canRetry"]
        assert client.post(f"/api/try-on/requests/{request['id']}/retry", headers=auth).status_code == 200
        run_queue(vto)
        body = client.get(f"/api/try-on/requests/{request['id']}", headers=auth).json()["data"]
        assert body["status"] == "failed" and body["canRetry"] is False
        assert client.post(f"/api/try-on/requests/{request['id']}/retry", headers=auth).status_code == 409

    def test_cancelling_a_queued_request_gives_the_unit_back(self, client, auth, member, vto):
        request = start(client, auth, _photo(client, auth)).json()["data"]
        response = client.post(f"/api/try-on/requests/{request['id']}/cancel", headers=auth)
        assert response.json()["data"]["status"] == "cancelled"
        assert _usage(vto, request["id"]).status == "released"
        assert run_queue(vto) == 0

    def test_a_membership_that_ends_while_queued_stops_the_request(self, client, auth, member, vto):
        request = start(client, auth, _photo(client, auth)).json()["data"]
        member.status = "cancelled"
        vto.commit()
        run_queue(vto)
        body = client.get(f"/api/try-on/requests/{request['id']}", headers=auth).json()["data"]
        assert body["status"] == "failed" and body["error"]["code"] == "plan_ineligible"
        assert _usage(vto, request["id"]).status == "released"


# ------------------------------------------------------- customers' privacy


class TestOwnership:
    @pytest.fixture()
    def other_auth(self, client, other_customer):
        response = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"})
        return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}

    def test_nobody_else_can_see_or_touch_a_try_on(self, client, auth, other_auth, member, vto):
        photo = _photo(client, auth)
        request = start(client, auth, photo).json()["data"]
        run_queue(vto)
        for method, path in (("GET", ""), ("GET", "/image"), ("GET", "/image?which=original"), ("DELETE", ""),
                             ("POST", "/retry"), ("POST", "/cancel"), ("GET", "/download")):
            response = client.request(method, f"/api/try-on/requests/{request['id']}{path}", headers=other_auth)
            assert response.status_code == 404, (method, path, response.text)

    def test_another_customers_photo_cannot_be_used(self, client, auth, other_auth, member, vto):
        make_member(vto, customer_id="CUS002", membership_id="MEM901")
        photo = _photo(client, auth)
        response = start(client, other_auth, photo)
        assert response.status_code == 404 and response.json()["error_code"] == "PHOTO_NOT_FOUND"
        assert client.delete(f"/api/try-on/photos/{photo}", headers=other_auth).status_code == 404


# -------------------------------------------------------------- credentials


@pytest.fixture()
def hf(vto):
    """The Hugging Face model, which needs a credential, as the only runnable model."""
    from app.models import VtoModel

    vto.get(VtoModel, "VMD900").enabled = False
    vto.commit()
    return vto


class TestCredentials:
    def _add(self, client, admin_auth, **extra):
        return client.post("/api/admin/try-on/credentials", headers=admin_auth,
                           json={"providerId": "VPR001", "secret": SECRET, "label": "Main", **extra})

    def test_a_token_goes_in_and_never_comes_out(self, client, admin_auth, vto):
        from app.models import AuditLog, VtoCredential
        from app.services.try_on import crypto

        response = self._add(client, admin_auth)
        assert response.status_code == 201, response.text
        assert SECRET not in response.text and SECRET[-12:] not in response.text
        data = response.json()["data"]
        assert data["masked"].endswith(SECRET[-4:]) and data["state"] == "unvalidated"
        listed = client.get("/api/admin/try-on/credentials", headers=admin_auth)
        assert SECRET not in listed.text and "secretSealed" not in listed.text
        row = vto.get(VtoCredential, data["id"])
        assert row.secret_sealed and SECRET not in row.secret_sealed
        assert crypto.unseal(row.secret_sealed) == SECRET
        logs = vto.execute(select(AuditLog)).scalars().all()
        assert logs and all(SECRET not in str(log.changes) + str(log.details) + log.summary for log in logs)

    def test_the_same_token_twice_is_refused(self, client, admin_auth, vto):
        self._add(client, admin_auth)
        assert self._add(client, admin_auth).status_code == 409

    def test_bulk_add_reports_lines_without_echoing_them(self, client, admin_auth, vto):
        response = client.post("/api/admin/try-on/credentials/bulk", headers=admin_auth, json={
            "providerId": "VPR001", "labelPrefix": "HF",
            "secrets": f"{SECRET}\nhf_SecondToken00000000000000\n{SECRET}\nbad token\n\n",
        })
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        assert len(data["added"]) == 2
        assert data["skipped"] == [{"line": 3, "reason": "already saved"},
                                   {"line": 4, "reason": "not a token (too short or contains spaces)"}]
        assert SECRET not in response.text and "hf_SecondToken" not in response.text

    def test_only_administrators_with_the_permission_see_credentials(self, client, vto, editor):
        response = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"})
        headers = {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}
        assert client.get("/api/admin/try-on/credentials", headers=headers).status_code == 403

    def test_categories_must_be_supported_by_the_models(self, client, admin_auth, vto):
        response = self._add(client, admin_auth, modelIds=["VMD001"], capabilityKeys=["garment.dress"])
        assert response.status_code == 422 and response.json()["error_code"] == "UNSUPPORTED_CAPABILITY"
        assert self._add(client, admin_auth, modelIds=["VMD001"], capabilityKeys=["garment.upper_body"],
                         categoryIds=["CAT001"]).status_code == 201

    def test_hidden_is_still_used_disabled_is_not(self, client, admin_auth, hf):
        from app.models import VtoRequest
        from app.services.try_on import selection

        credential = self._add(client, admin_auth).json()["data"]["id"]
        request = VtoRequest(customer_id="CUS001", capability_key="garment.upper_body", category_id="CAT001")
        client.post(f"/api/admin/try-on/credentials/{credential}/hide", headers=admin_auth)
        assert credential not in client.get("/api/admin/try-on/credentials", headers=admin_auth).text
        assert credential in client.get("/api/admin/try-on/credentials?includeHidden=true", headers=admin_auth).text
        assert [c.credential.id for c in selection.candidates(hf, request)] == [credential]
        client.post(f"/api/admin/try-on/credentials/{credential}/disable", headers=admin_auth)
        assert selection.candidates(hf, request) == []

    def test_rotation_and_deletion(self, client, admin_auth, hf):
        from app.models import VtoCredential

        credential = self._add(client, admin_auth).json()["data"]["id"]
        response = client.put(f"/api/admin/try-on/credentials/{credential}/secret", headers=admin_auth,
                              json={"secret": "hf_RotatedToken99999999999999"})
        assert response.json()["data"]["masked"].endswith("9999")
        response = client.delete(f"/api/admin/try-on/credentials/{credential}", headers=admin_auth)
        assert response.json()["data"]["state"] == "deleted"
        row = hf.get(VtoCredential, credential)
        assert row.secret_sealed is None and row.fingerprint is None and row.label == "Main"
        # The token can be added again, and the history still names the old one.
        assert self._add(client, admin_auth, secret="hf_RotatedToken99999999999999").status_code == 201

    def test_validation_asks_the_provider(self, client, admin_auth, hf, monkeypatch):
        import httpx

        credential = self._add(client, admin_auth).json()["data"]["id"]
        sent = []

        def fake_get(url, headers, timeout):
            sent.append(headers["Authorization"])
            return httpx.Response(401, json={"error": "Invalid credentials in Authorization header"},
                                  request=httpx.Request("GET", url))

        monkeypatch.setattr(httpx, "get", fake_get)
        data = client.post(f"/api/admin/try-on/credentials/{credential}/validate", headers=admin_auth).json()["data"]
        assert sent == [f"Bearer {SECRET}"]
        assert data["state"] == "invalid" and data["lastError"] == "The AI service rejected the configured credentials."

        monkeypatch.setattr(httpx, "get", lambda url, headers, timeout: httpx.Response(
            200, json={"type": "user", "auth": {"accessToken": {"role": "read"}}}, request=httpx.Request("GET", url)))
        data = client.post(f"/api/admin/try-on/credentials/{credential}/validate", headers=admin_auth).json()["data"]
        assert data["state"] == "healthy" and data["status"] == "active"
        assert data["rateLimitInfo"]["tokenRole"] == "read"


class TestDedicatedIsolation:
    def _dedicated(self, db, customer_id="CUS001", allocation=True):
        from app.models import VtoAllocation
        from app.services.try_on import credentials

        row = credentials.add(db, {"providerId": "VPR001", "secret": SECRET, "label": "Asha's own",
                                   "scope": "dedicated", "dedicatedCustomerId": customer_id, "autoSelect": True})
        assert row.auto_select is False  # never shared, whatever was asked
        if allocation:
            now = datetime.utcnow()
            db.add(VtoAllocation(id="VAL900", customer_id=customer_id, kind="dedicated_credential",
                                 credential_id=row.id, generations=5, capability_keys=[], starts_at=now - timedelta(hours=1),
                                 status="active", note="", created_by="ADM001", created_at=now, updated_at=now))
        db.commit()
        return row

    def _request(self, customer_id):
        from app.models import VtoRequest

        return VtoRequest(customer_id=customer_id, capability_key="garment.upper_body", category_id="CAT001")

    def test_only_its_owner_can_use_a_dedicated_credential(self, hf, customer, other_customer):
        from app.services.try_on import selection

        row = self._dedicated(hf)
        assert [c.credential.id for c in selection.candidates(hf, self._request("CUS001"))] == [row.id]
        assert selection.candidates(hf, self._request("CUS002")) == []

    def test_without_an_active_allocation_not_even_the_owner(self, hf, customer):
        from app.models import VtoAllocation
        from app.services.try_on import allocations, selection

        self._dedicated(hf)
        allocations.revoke(hf, "VAL900")
        hf.commit()
        assert hf.get(VtoAllocation, "VAL900").status == "revoked"
        assert selection.candidates(hf, self._request("CUS001")) == []

    def test_an_allocation_cannot_hand_a_dedicated_credential_to_someone_else(self, hf, customer, other_customer):
        from app.core.errors import ValidationError
        from app.services.try_on import allocations

        row = self._dedicated(hf, allocation=False)
        with pytest.raises(ValidationError):
            allocations.create_allocation(hf, {"customerId": "CUS002", "kind": "dedicated_credential",
                                               "credentialId": row.id}, admin_id="ADM001")

    def test_another_customer_has_no_capacity_through_the_api(self, client, auth, hf, other_customer, ephemeral):
        make_plan(hf)
        make_member(hf, customer_id="CUS002", membership_id="MEM901")
        self._dedicated(hf)
        login = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"})
        other = {"Authorization": f"Bearer {login.json()['data']['token']['accessToken']}"}
        photo = _photo(client, other)
        response = start(client, other, photo)
        assert response.status_code == 503 and response.json()["error_code"] == "TRY_ON_NO_CAPACITY"


class TestFallback:
    def test_a_rejected_credential_falls_back_to_the_next(self, client, auth, member, vto):
        from app.models import VtoAttempt, VtoCredential
        from app.services.try_on import credentials

        bad = credentials.add(vto, {"providerId": "VPR900", "secret": "invalid-token-0001", "label": "Bad",
                                    "priority": 1})
        good = credentials.add(vto, {"providerId": "VPR900", "secret": "good-token-00002", "label": "Good",
                                     "priority": 2})
        vto.commit()
        request = start(client, auth, _photo(client, auth)).json()["data"]
        run_queue(vto)
        body = client.get(f"/api/try-on/requests/{request['id']}", headers=auth).json()["data"]
        assert body["status"] == "succeeded"
        attempts = vto.execute(select(VtoAttempt).order_by(VtoAttempt.number)).scalars().all()
        assert [(a.credential_id, a.outcome, a.error_code) for a in attempts] == [
            (bad.id, "failed", "invalid_credentials"), (good.id, "succeeded", "")]
        assert vto.get(VtoCredential, bad.id).status == "invalid"
        assert vto.get(VtoCredential, good.id).success_count == 1

    def test_a_rate_limited_credential_rests(self, client, auth, member, vto):
        from app.models import VtoCredential, VtoModel
        from app.services.try_on import credentials

        row = credentials.add(vto, {"providerId": "VPR900", "secret": "good-token-00003", "label": "Only"})
        vto.get(VtoModel, "VMD900").config = {"fail": "rate_limited"}
        vto.commit()
        start(client, auth, _photo(client, auth))
        run_queue(vto)
        row = vto.get(VtoCredential, row.id)
        assert row.status == "rate_limited" and row.cooldown_until > datetime.utcnow()
        assert credentials.effective_status(row) == "rate_limited"


# ------------------------------------------------------------------ storage


class TestS3Storage:
    def test_permanent_results_go_to_the_private_prefix(self, client, auth, vto, customer, s3):
        make_plan(vto, retention="permanent")
        make_member(vto)
        photo = _photo(client, auth)
        assert s3.puts[0]["Key"].startswith("try-on/photos/cus001/")
        assert s3.puts[0]["ServerSideEncryption"] == "AES256"
        assert s3.puts[0]["CacheControl"] == "private, no-store"
        request = start(client, auth, photo).json()["data"]
        run_queue(vto)
        body = client.get(f"/api/try-on/requests/{request['id']}", headers=auth).json()["data"]
        assert body["result"]["mode"] == "permanent" and body["result"]["expiresAt"] is None
        assert any(p["Key"].startswith("try-on/results/") for p in s3.puts)
        link = client.get(f"/api/try-on/requests/{request['id']}/download", headers=auth).json()["data"]["url"]
        assert link.startswith("https://signed.example/try-on/results/")

    def test_temporary_results_expire_and_are_deleted(self, client, auth, vto, customer, s3):
        from app.models import VtoRequest
        from app.services.try_on import jobs

        make_plan(vto, retention="temporary", retentionDays=3)
        make_member(vto)
        request = start(client, auth, _photo(client, auth)).json()["data"]
        run_queue(vto)
        row = vto.get(VtoRequest, request["id"])
        assert row.storage_mode == "temporary"
        assert timedelta(days=2) < row.result_expires_at - datetime.utcnow() <= timedelta(days=3, seconds=1)
        result_key = row.result_key
        jobs.sweep(vto, now=datetime.utcnow() + timedelta(days=4))
        assert result_key in s3.deleted and result_key not in s3.objects
        row = vto.get(VtoRequest, request["id"])
        assert row.status == "expired" and row.result_deleted_at is not None
        assert client.get(f"/api/try-on/requests/{request['id']}/image", headers=auth).status_code == 404

    def test_a_failed_deletion_is_retried_until_it_succeeds(self, client, auth, vto, customer, s3):
        from app.models import VtoCleanupTask
        from app.services.try_on import jobs

        make_plan(vto)
        make_member(vto)
        request = start(client, auth, _photo(client, auth)).json()["data"]
        run_queue(vto)
        s3.fail_delete = True
        response = client.delete(f"/api/try-on/requests/{request['id']}", headers=auth)
        assert response.json()["data"]["pending"] is True
        # Already inaccessible through the application.
        assert client.get(f"/api/try-on/requests/{request['id']}/image", headers=auth).status_code == 404
        tasks = vto.execute(select(VtoCleanupTask).where(VtoCleanupTask.done_at.is_(None))).scalars().all()
        assert len(tasks) == 2  # the result and the unsaved photo
        s3.fail_delete = False
        jobs.retry_cleanup(vto, datetime.utcnow() + timedelta(hours=1))
        assert all(t.done_at for t in tasks)
        assert not [k for k in s3.objects if k.startswith("try-on/")]

    def test_a_prefix_inside_the_public_one_is_never_used(self, monkeypatch, s3):
        from app.services.try_on import storage

        monkeypatch.setattr(settings, "VTO_S3_PREFIX", "products/try-on")
        assert "public" in storage.s3_problem()
        assert storage.active_name() == "ephemeral"
        monkeypatch.setattr(settings, "VTO_STORAGE", "s3")
        assert storage.active_name() == ""

    def test_storage_switched_off_is_a_friendly_refusal(self, client, auth, member, monkeypatch):
        monkeypatch.setattr(settings, "VTO_STORAGE", "disabled")
        response = upload(client, auth)
        assert response.status_code == 503 and response.json()["error_code"] == "TRY_ON_STORAGE_UNAVAILABLE"

    def test_a_result_is_kept_temporarily_when_the_bucket_fails(self, client, auth, vto, customer, s3):
        from app.models import VtoRequest

        make_plan(vto)
        make_member(vto)
        request = start(client, auth, _photo(client, auth)).json()["data"]
        s3.fail_put = True
        run_queue(vto)
        row = vto.get(VtoRequest, request["id"])
        assert row.status == "succeeded" and row.result_storage == "ephemeral" and row.storage_mode == "ephemeral"
        assert client.get(f"/api/try-on/requests/{request['id']}/image", headers=auth).status_code == 200


# ---------------------------------------------------------------- the store


class TestAdministration:
    def test_the_dashboard_counts_what_happened(self, client, auth, admin_auth, member, vto):
        from app.models import VtoModel

        photo = _photo(client, auth)
        start(client, auth, photo)
        run_queue(vto)
        vto.get(VtoModel, "VMD900").config = {"fail": "provider_unavailable"}
        vto.commit()
        start(client, auth, photo)
        run_queue(vto)
        data = client.get("/api/admin/try-on/overview", headers=admin_auth).json()["data"]
        assert data["totals"]["requests"] == 2 and data["totals"]["succeeded"] == 1 and data["totals"]["failed"] == 1
        assert data["totals"]["successRate"] == 50.0
        assert data["byModel"][0]["label"] == "Mock overlay"
        assert data["byError"][0]["badge"] == "Provider Unavailable"
        assert data["byPlan"][0]["label"] == "Prime"
        assert data["totals"]["estimatedCost"] == 0.02

        failed = client.get("/api/admin/try-on/requests?status=failed", headers=admin_auth).json()["data"]
        assert failed["pagination"]["total"] == 1
        detail = client.get(f"/api/admin/try-on/requests/{failed['items'][0]['id']}", headers=admin_auth).json()["data"]
        assert detail["badge"] == "Provider Unavailable"
        assert detail["error"]["explanation"].startswith("The AI service is temporarily unavailable")
        assert detail["attemptLog"][0]["outcome"] == "failed"

    def test_plan_entitlements_are_validated(self, client, admin_auth, vto):
        make_plan(vto)
        response = client.put("/api/admin/try-on/plans/MBP900", headers=admin_auth,
                              json={"tryOn": {"enabled": True, "perPeriod": 0}})
        assert response.status_code == 422
        response = client.put("/api/admin/try-on/plans/MBP900", headers=admin_auth,
                              json={"tryOn": {"enabled": True, "perPeriod": 20, "retention": "permanent"}})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["tryOn"]["perPeriod"] == 20

    def test_access_request_approval_grants_an_allowance(self, client, auth, admin_auth, vto, customer, ephemeral):
        response = client.post("/api/try-on/access-requests", headers=auth,
                               json={"reason": "Wedding shopping this month", "expectedUsage": 5,
                                     "capabilities": ["garment.upper_body"]})
        assert response.status_code == 201, response.text
        request_id = response.json()["data"]["id"]
        assert client.get("/api/admin/nav-counts", headers=admin_auth).json()["data"]["tryOnAccessRequests"] == 1
        response = client.post(f"/api/admin/try-on/access-requests/{request_id}/approve", headers=admin_auth,
                               json={"note": "Enjoy", "allocation": {"generations": 2}})
        assert response.status_code == 200, response.text
        data = client.get("/api/try-on/eligibility", headers=auth).json()["data"]
        assert data["eligible"] and data["source"] == "allocation"
        assert data["allocations"][0]["remaining"] == 2
        mine = client.get("/api/try-on/access-requests", headers=auth).json()["data"]
        assert mine[0]["status"] == "approved"
        assert "credential" not in str(client.get("/api/try-on/allocations", headers=auth).json()).lower()

    def test_mapping_a_category(self, client, admin_auth, vto):
        response = client.post("/api/admin/try-on/mappings", headers=admin_auth,
                               json={"categoryId": "CAT002", "capabilityKey": "wrist.watch"})
        assert response.status_code == 201
        assert client.post("/api/admin/try-on/mappings", headers=admin_auth,
                           json={"categoryId": "CAT002", "capabilityKey": "wrist.watch"}).status_code == 409
        catalogue = client.get("/api/try-on/catalogue").json()["data"]
        states = {c["key"]: c["state"] for c in catalogue["capabilities"]}
        assert states["garment.upper_body"] == "available" and states["wrist.watch"] == "coming_soon"
        assert states["garment.dress"] == "unsupported"
        assert {"category": "electronics", "subcategory": "", "capability": "wrist.watch"} in catalogue["mappings"]

    def test_a_model_cannot_claim_what_its_adapter_cannot_do(self, client, admin_auth, vto):
        response = client.put("/api/admin/try-on/models/VMD001", headers=admin_auth,
                              json={"capabilities": ["eyewear.frames"]})
        assert response.status_code == 422 and response.json()["error_code"] == "UNSUPPORTED_CAPABILITY"

    def test_unverified_models_are_never_routed(self, vto):
        from app.models import VtoModel
        from app.services.try_on import catalogue

        model = vto.get(VtoModel, "VMD002")
        model.enabled = True
        vto.commit()
        assert catalogue.runnable_models(vto, "garment.dress") == []
        model.verified = True
        vto.commit()
        assert [m.id for m in catalogue.runnable_models(vto, "garment.dress")] == ["VMD002"]


class TestNoFalsePromises:
    def test_a_kind_with_no_usable_credential_is_not_offered(self, client, admin_auth, vto):
        """The Hugging Face model needs a token: without one, nobody is shown a button that can only fail."""
        from app.models import VtoModel

        vto.get(VtoModel, "VMD900").enabled = False
        vto.commit()
        states = {c["key"]: c["state"] for c in client.get("/api/try-on/catalogue").json()["data"]["capabilities"]}
        assert states["garment.upper_body"] == "unavailable"
        response = client.post("/api/admin/try-on/credentials", headers=admin_auth,
                               json={"providerId": "VPR001", "secret": "hf_AnyToken1234567890", "label": "HF"})
        assert response.status_code == 201
        states = {c["key"]: c["state"] for c in client.get("/api/try-on/catalogue").json()["data"]["capabilities"]}
        assert states["garment.upper_body"] == "available"
        client.post(f"/api/admin/try-on/credentials/{response.json()['data']['id']}/disable", headers=admin_auth)
        states = {c["key"]: c["state"] for c in client.get("/api/try-on/catalogue").json()["data"]["capabilities"]}
        assert states["garment.upper_body"] == "unavailable"


def test_browsers_may_send_the_request_key(client):
    """The storefront sends Idempotency-Key from another origin: the CORS preflight must allow it."""
    origin = settings.CORS_ORIGINS[0]
    response = client.options("/api/try-on/requests", headers={
        "Origin": origin, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,idempotency-key"})
    assert response.status_code == 200
    assert "idempotency-key" in response.headers["access-control-allow-headers"].lower()


def test_a_check_that_cannot_reach_the_provider_is_not_never_checked(client, admin_auth, vto, monkeypatch):
    import httpx

    response = client.post("/api/admin/try-on/credentials", headers=admin_auth,
                           json={"providerId": "VPR001", "secret": "hf_NetworkTest1234567890", "label": "HF"})
    credential = response.json()["data"]["id"]

    def unreachable(url, headers, timeout):
        raise httpx.ConnectError("[WinError 10054] An existing connection was forcibly closed by the remote host")

    monkeypatch.setattr(httpx, "get", unreachable)
    response = client.post(f"/api/admin/try-on/credentials/{credential}/validate", headers=admin_auth)
    body = response.json()
    assert body["data"]["state"] == "check_failed" and body["data"]["status"] == "active"
    assert body["message"] == ("Couldn't check it: The AI service is temporarily unavailable (down, sleeping or "
                               "building). Try again in a moment.")


def test_a_successful_check_clears_the_earlier_error(client, admin_auth, vto, monkeypatch):
    import httpx

    credential = client.post("/api/admin/try-on/credentials", headers=admin_auth, json={
        "providerId": "VPR001", "secret": "hf_RecoveryTest1234567890", "label": "HF"}).json()["data"]["id"]
    monkeypatch.setattr(httpx, "get", lambda url, headers, timeout: (_ for _ in ()).throw(httpx.ConnectError("reset")))
    client.post(f"/api/admin/try-on/credentials/{credential}/validate", headers=admin_auth)
    monkeypatch.setattr(httpx, "get", lambda url, headers, timeout: httpx.Response(
        200, json={"type": "user", "auth": {"accessToken": {"role": "read"}}}, request=httpx.Request("GET", url)))
    data = client.post(f"/api/admin/try-on/credentials/{credential}/validate", headers=admin_auth).json()["data"]
    assert data["state"] == "healthy" and data["lastError"] == "" and data["lastErrorCode"] == ""
