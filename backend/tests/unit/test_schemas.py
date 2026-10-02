"""
Request schemas: what the API accepts before any business rule sees it.

Each rule is tested at its edges: the last value accepted and the first one
refused. Inputs use the camelCase the frontend sends, which is the shape that
actually arrives, and the snake_case names are checked to work too.
"""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.api.routes.admin.catalogue import StockUpdate
from app.api.routes.alerts import PriceAlertRequest, StockAlertRequest
from app.api.routes.cart import AddToCart, UpdateQuantity
from app.api.routes.comparison import MergeRequest
from app.api.routes.growth import AddBundle, BundleQuantity, Selection
from app.api.routes.messaging import ClickIn, TokenIn
from app.api.routes.messaging import TestIn as MessagingTestIn
from app.api.routes.questions import AnswerRequest, AskRequest
from app.api.routes.returns import ReturnItemIn, ReturnRequestIn
from app.api.routes.reviews import ReviewCreate
from app.api.routes.wallet import (
    CodeRequest,
    CreditAdjustRequest,
    IssueRequest,
    PointsAdjustRequest,
    PurchaseRequest,
    TenderPreviewRequest,
)
from app.schemas.auth import (
    AddressWrite,
    AdminUserOut,
    AdminUserWrite,
    LoginRequest,
    PasswordChange,
    RegisterRequest,
    ResetPasswordRequest,
    TokenRequest,
    password_strength,
)
from app.schemas.billing import CreditNoteCreate, RefundCreate
from app.schemas.catalogue import ColorIn, ProductQuery, ProductWrite
from app.schemas.orders import PlaceOrderRequest


def _fails(model, data, field: str | None = None):
    with pytest.raises(ValidationError) as caught:
        model.model_validate(data)
    if field:
        locations = {".".join(str(p) for p in error["loc"]) for error in caught.value.errors()}
        assert any(field in loc for loc in locations), locations
    return caught.value


# -------------------------------------------------------------------- auth


REGISTER = {"email": "a@b.co", "password": "abcdefg1", "firstName": "Asha"}


class TestPasswordStrength:
    @pytest.mark.parametrize("value", ["abcdefg1", "1234567a", "Pässwörd9"])
    def test_letter_and_digit_pass(self, value):
        assert password_strength(value) == value

    @pytest.mark.parametrize("value, why", [("12345678", "letter"), ("abcdefgh", "number"), ("", "letter")])
    def test_missing_class_fails(self, value, why):
        with pytest.raises(ValueError, match=why):
            password_strength(value)


class TestRegisterRequest:
    def test_minimal_valid(self):
        request = RegisterRequest.model_validate(REGISTER)
        assert request.first_name == "Asha"
        assert request.last_name == "" and request.phone == "" and request.referral_code is None
        assert request.marketing_opt_in is None

    def test_snake_case_names_are_accepted(self):
        request = RegisterRequest.model_validate({"email": "a@b.co", "password": "abcdefg1", "first_name": "R"})
        assert request.first_name == "R"

    @pytest.mark.parametrize("missing", ["email", "password", "firstName"])
    def test_required_fields(self, missing):
        data = dict(REGISTER)
        data.pop(missing)
        _fails(RegisterRequest, data)

    @pytest.mark.parametrize("email", ["not-an-email", "a@", "@b.co", "", "a b@c.co"])
    def test_invalid_email(self, email):
        _fails(RegisterRequest, {**REGISTER, "email": email}, "email")

    def test_password_length_boundaries(self):
        _fails(RegisterRequest, {**REGISTER, "password": "abcdef1"}, "password")  # 7
        RegisterRequest.model_validate({**REGISTER, "password": "a" * 71 + "1"})  # 72
        _fails(RegisterRequest, {**REGISTER, "password": "a" * 72 + "1"}, "password")  # 73

    def test_password_must_have_letter_and_digit(self):
        _fails(RegisterRequest, {**REGISTER, "password": "abcdefgh"}, "password")

    def test_first_name_boundaries(self):
        _fails(RegisterRequest, {**REGISTER, "firstName": ""}, "first")
        RegisterRequest.model_validate({**REGISTER, "firstName": "x" * 80})
        _fails(RegisterRequest, {**REGISTER, "firstName": "x" * 81}, "first")

    def test_long_phone_and_referral_code_are_refused(self):
        _fails(RegisterRequest, {**REGISTER, "phone": "9" * 21}, "phone")
        _fails(RegisterRequest, {**REGISTER, "referralCode": "R" * 33}, "referral")

    def test_wrong_types(self):
        _fails(RegisterRequest, {**REGISTER, "password": 12345678})
        _fails(RegisterRequest, {**REGISTER, "marketingOptIn": "perhaps"})

    def test_an_invented_role_field_is_ignored(self):
        """No role on the schema: a payload that names one changes nothing."""
        request = RegisterRequest.model_validate({**REGISTER, "role": "super-admin"})
        assert not hasattr(request, "role")


class TestOtherAuthSchemas:
    def test_login_needs_a_valid_email_and_a_password(self):
        LoginRequest.model_validate({"email": "a@b.co", "password": "x"})
        _fails(LoginRequest, {"email": "nope", "password": "x"}, "email")
        _fails(LoginRequest, {"email": "a@b.co"}, "password")

    def test_token_request_bounds(self):
        _fails(TokenRequest, {"token": ""})
        TokenRequest.model_validate({"token": "t" * 200})
        _fails(TokenRequest, {"token": "t" * 201})

    def test_reset_password(self):
        ResetPasswordRequest.model_validate({"token": "t", "password": "abcdefg1", "confirmPassword": "x"})
        _fails(ResetPasswordRequest, {"token": "t", "password": "abcdefgh", "confirmPassword": ""}, "password")
        _fails(ResetPasswordRequest, {"token": "t", "password": "abcdefg1"}, "confirm")

    def test_password_change_bounds(self):
        PasswordChange.model_validate({"currentPassword": "x", "newPassword": "12345678"})
        _fails(PasswordChange, {"currentPassword": "x", "newPassword": "1234567"}, "new")

    @pytest.mark.parametrize(
        "field, value",
        [("fullName", "A"), ("line1", "ab"), ("city", "B"), ("state", "K"), ("pincode", "123"),
         ("pincode", "1" * 13), ("phone", "9" * 21)],
    )
    def test_address_write_bounds(self, field, value):
        valid = {"fullName": "Asha Rao", "line1": "4 Road", "city": "Blr", "state": "KA", "pincode": "560001"}
        AddressWrite.model_validate(valid)
        _fails(AddressWrite, {**valid, field: value})

    def test_address_defaults(self):
        address = AddressWrite.model_validate(
            {"fullName": "Asha Rao", "line1": "4 Road", "city": "Blr", "state": "KA", "pincode": "560001"})
        assert (address.country, address.type, address.is_default) == ("India", "home", False)

    def test_admin_user_write(self):
        AdminUserWrite.model_validate({})
        _fails(AdminUserWrite, {"email": "bad"}, "email")
        _fails(AdminUserWrite, {"password": "short"}, "password")

    def test_admin_out_derives_initials(self):
        admin = SimpleNamespace(id="ADM1", name="manoj kumar rajan", email="a@b.co", role="admin",
                                status="active", permissions=None, last_login_at=None,
                                created_at=datetime(2026, 1, 1))
        out = AdminUserOut.from_model(admin)
        assert out.avatar_initials == "MK"
        assert out.permissions == []
        assert "password" not in out.model_dump()


# ------------------------------------------------------------------- cart


class TestCartSchemas:
    @pytest.mark.parametrize("quantity", [1, 10])
    def test_add_quantity_in_range(self, quantity):
        assert AddToCart.model_validate({"productId": "PRD001", "quantity": quantity}).quantity == quantity

    @pytest.mark.parametrize("quantity", [0, -1, 11, 1000])
    def test_add_quantity_out_of_range(self, quantity):
        _fails(AddToCart, {"productId": "PRD001", "quantity": quantity}, "quantity")

    def test_add_defaults_to_one(self):
        assert AddToCart.model_validate({"productId": "PRD001"}).quantity == 1

    def test_add_product_id_bounds(self):
        _fails(AddToCart, {"productId": ""}, "product")
        _fails(AddToCart, {"productId": "P" * 41}, "product")
        _fails(AddToCart, {}, "product")

    def test_add_wrong_quantity_type(self):
        _fails(AddToCart, {"productId": "PRD001", "quantity": "lots"}, "quantity")

    def test_add_long_size_and_colour(self):
        _fails(AddToCart, {"productId": "P", "size": "S" * 31})
        _fails(AddToCart, {"productId": "P", "color": "C" * 61})

    @pytest.mark.parametrize("quantity, ok", [(0, True), (10, True), (-1, False), (11, False)])
    def test_update_quantity_allows_zero(self, quantity, ok):
        if ok:
            UpdateQuantity.model_validate({"quantity": quantity})
        else:
            _fails(UpdateQuantity, {"quantity": quantity})


# ----------------------------------------------------------------- orders


ADDRESS = {"fullName": "Asha", "line1": "4 Road", "city": "Blr", "state": "KA", "pincode": "560001"}


class TestPlaceOrderRequest:
    def test_defaults(self):
        request = PlaceOrderRequest.model_validate({"shippingAddress": ADDRESS})
        assert request.delivery_method == "standard"
        assert request.payment_method == "upi"
        assert request.billing_address is None
        assert request.gift_card_codes == [] and request.points == 0
        assert request.expected_total is None

    def test_shipping_address_is_required_and_complete(self):
        _fails(PlaceOrderRequest, {}, "shipping")
        _fails(PlaceOrderRequest, {"shippingAddress": {"fullName": "A"}}, "shipping")

    def test_a_client_supplied_total_is_not_a_field(self):
        request = PlaceOrderRequest.model_validate({"shippingAddress": ADDRESS, "total": 1, "price": 1})
        assert not hasattr(request, "total")

    def test_points_bounds(self):
        _fails(PlaceOrderRequest, {"shippingAddress": ADDRESS, "points": -1}, "points")
        PlaceOrderRequest.model_validate({"shippingAddress": ADDRESS, "points": 10_000_000})
        _fails(PlaceOrderRequest, {"shippingAddress": ADDRESS, "points": 10_000_001}, "points")

    def test_at_most_five_gift_cards(self):
        PlaceOrderRequest.model_validate({"shippingAddress": ADDRESS, "giftCardCodes": ["A"] * 5})
        _fails(PlaceOrderRequest, {"shippingAddress": ADDRESS, "giftCardCodes": ["A"] * 6}, "gift")

    def test_expected_total_cannot_be_negative(self):
        _fails(PlaceOrderRequest, {"shippingAddress": ADDRESS, "expectedTotal": -1}, "expected")
        PlaceOrderRequest.model_validate({"shippingAddress": ADDRESS, "expectedTotal": 0})


# -------------------------------------------------------------- catalogue


class TestProductWrite:
    def test_everything_optional(self):
        assert ProductWrite.model_validate({}).model_dump(exclude_none=True) == {}

    @pytest.mark.parametrize("field", ["price", "originalPrice", "stock", "lowStockThreshold", "reservedStock",
                                       "taxRatePercent"])
    def test_negative_numbers_are_refused(self, field):
        _fails(ProductWrite, {field: -1})

    @pytest.mark.parametrize("field", ["price", "originalPrice", "stock", "taxRatePercent"])
    def test_zero_is_allowed(self, field):
        ProductWrite.model_validate({field: 0})

    def test_tax_rate_ceiling(self):
        ProductWrite.model_validate({"taxRatePercent": 100})
        _fails(ProductWrite, {"taxRatePercent": 100.01})

    @pytest.mark.parametrize("status", ["active", "draft", "out-of-stock", "archived"])
    def test_known_statuses(self, status):
        ProductWrite.model_validate({"status": status})

    @pytest.mark.parametrize("status", ["deleted", "ACTIVE", ""])
    def test_unknown_status(self, status):
        _fails(ProductWrite, {"status": status}, "status")

    def test_price_must_be_a_number(self):
        _fails(ProductWrite, {"price": "cheap"}, "price")


class TestColorIn:
    def test_images_are_trimmed_deduplicated_and_blanks_dropped(self):
        color = ColorIn.model_validate({"name": "Red", "images": [" https://a.test/1.jpg ", "",
                                                                  "https://a.test/1.jpg", "http://a.test/2.jpg"]})
        assert color.images == ["https://a.test/1.jpg", "http://a.test/2.jpg"]
        assert color.hex == "#000000"

    @pytest.mark.parametrize("url", ["ftp://a.test/x.jpg", "javascript:alert(1)", "/local.jpg"])
    def test_non_web_addresses_are_refused(self, url):
        _fails(ColorIn, {"name": "Red", "images": [url]})

    def test_too_long_an_address(self):
        _fails(ColorIn, {"name": "Red", "images": ["https://a.test/" + "x" * 500]})

    def test_at_most_twelve_images(self):
        ColorIn.model_validate({"name": "R", "images": [f"https://a.test/{i}" for i in range(12)]})
        _fails(ColorIn, {"name": "R", "images": [f"https://a.test/{i}" for i in range(13)]})

    def test_name_bounds(self):
        _fails(ColorIn, {"name": ""})
        _fails(ColorIn, {"name": "x" * 61})


class TestProductQuery:
    def test_defaults(self):
        query = ProductQuery()
        assert (query.page, query.page_size, query.sort) == (1, 24, "recommended")
        assert not query.in_stock_only and not query.include_unpublished

    @pytest.mark.parametrize("field, value", [("page", 0), ("pageSize", 0), ("pageSize", 101)])
    def test_paging_bounds(self, field, value):
        _fails(ProductQuery, {field: value})

    def test_page_size_ceiling_is_inclusive(self):
        assert ProductQuery.model_validate({"pageSize": 100}).page_size == 100

    @pytest.mark.parametrize("sort", ["recommended", "newest", "price-asc", "price-desc", "rating", "popular",
                                      "discount"])
    def test_sort_options(self, sort):
        ProductQuery.model_validate({"sort": sort})

    def test_unknown_sort(self):
        _fails(ProductQuery, {"sort": "price_asc"}, "sort")

    def test_csv_lists_are_split(self):
        query = ProductQuery.model_validate({"brands": "Anvi, Meridian,,", "sizes": ["M", "L"], "colors": "Red"})
        assert query.brands == ["Anvi", "Meridian"]
        assert query.sizes == ["M", "L"]
        assert query.colors == ["Red"]


# ---------------------------------------------------------------- billing


class TestBillingRequests:
    @pytest.mark.parametrize("amount", [0, -100])
    def test_refund_amount_must_be_positive(self, amount):
        _fails(RefundCreate, {"invoiceId": "INV001", "amount": amount, "reason": "damaged"}, "amount")

    def test_refund_reason_minimum(self):
        _fails(RefundCreate, {"invoiceId": "INV001", "amount": 1, "reason": "x"}, "reason")
        assert RefundCreate.model_validate({"invoiceId": "INV001", "amount": 1, "reason": "ok"}).status == "completed"

    def test_credit_note(self):
        _fails(CreditNoteCreate, {"invoiceId": "INV001", "total": 0, "reason": "ok"}, "total")
        assert CreditNoteCreate.model_validate({"invoiceId": "I", "total": 5, "reason": "ok"}).status == "issued"


# ------------------------------------------------------------ storefront


class TestReviewCreate:
    VALID = {"productId": "PRD001", "rating": 5, "title": "Lovely", "body": "Fits really well."}

    @pytest.mark.parametrize("rating", [1, 5])
    def test_rating_bounds_accept(self, rating):
        ReviewCreate.model_validate({**self.VALID, "rating": rating})

    @pytest.mark.parametrize("rating", [0, 6, -1])
    def test_rating_bounds_refuse(self, rating):
        _fails(ReviewCreate, {**self.VALID, "rating": rating}, "rating")

    @pytest.mark.parametrize("field, value", [("title", "ab"), ("title", "t" * 201), ("body", "too short"),
                                              ("body", "b" * 4001)])
    def test_text_bounds(self, field, value):
        _fails(ReviewCreate, {**self.VALID, field: value}, field)


class TestAlerts:
    def test_price_alert_modes(self):
        assert PriceAlertRequest.model_validate({"productId": "P"}).mode == "any"
        PriceAlertRequest.model_validate({"productId": "P", "mode": "target", "targetPrice": 100})
        _fails(PriceAlertRequest, {"productId": "P", "mode": "sometimes"}, "mode")

    @pytest.mark.parametrize("price", [0, -5, 10_000_001])
    def test_target_price_bounds(self, price):
        _fails(PriceAlertRequest, {"productId": "P", "mode": "target", "targetPrice": price}, "target")

    def test_stock_alert(self):
        StockAlertRequest.model_validate({"productId": "P"})
        _fails(StockAlertRequest, {"productId": ""})
        _fails(StockAlertRequest, {"productId": "P", "size": "s" * 31})


class TestQuestions:
    def test_ask_bounds(self):
        _fails(AskRequest, {"question": ""}, "question")
        AskRequest.model_validate({"question": "q" * 2000})
        _fails(AskRequest, {"question": "q" * 2001}, "question")

    def test_answer_bounds(self):
        _fails(AnswerRequest, {"answer": ""})
        _fails(AnswerRequest, {"answer": "a" * 4001})


class TestReturns:
    def test_valid(self):
        request = ReturnRequestIn.model_validate(
            {"kind": "return", "reason": "Too small", "items": [{"orderItemId": 1, "quantity": 1}]})
        assert request.items[0].quantity == 1

    def test_unknown_kind(self):
        _fails(ReturnRequestIn, {"kind": "swap", "reason": "x", "items": [{"orderItemId": 1, "quantity": 1}]},
               "kind")

    def test_needs_at_least_one_item(self):
        _fails(ReturnRequestIn, {"kind": "return", "reason": "x", "items": []}, "items")

    @pytest.mark.parametrize("quantity", [0, 101])
    def test_item_quantity_bounds(self, quantity):
        _fails(ReturnItemIn, {"orderItemId": 1, "quantity": quantity}, "quantity")


class TestGrowth:
    def test_add_bundle_bounds(self):
        AddBundle.model_validate({"bundleId": 1})
        _fails(AddBundle, {"bundleId": 0}, "bundle")
        _fails(AddBundle, {"bundleId": 1, "quantity": 21}, "quantity")
        _fails(AddBundle, {"bundleId": 1, "selections": [{"productId": "P"}] * 11}, "selections")

    def test_bundle_quantity_allows_zero(self):
        BundleQuantity.model_validate({"quantity": 0})
        _fails(BundleQuantity, {"quantity": -1})

    def test_selection_needs_a_product(self):
        _fails(Selection, {"productId": ""})

    def test_comparison_holds_at_most_eight(self):
        MergeRequest.model_validate({"productIds": ["P"] * 8})
        _fails(MergeRequest, {"productIds": ["P"] * 9})


class TestWallet:
    def test_code_bounds(self):
        _fails(CodeRequest, {"code": ""})
        _fails(CodeRequest, {"code": "C" * 41})

    @pytest.mark.parametrize("amount, ok", [(0, False), (-1, False), (0.01, True), (1_000_000, True),
                                            (1_000_000.01, False)])
    def test_purchase_amount(self, amount, ok):
        data = {"amount": amount, "recipientName": "Ravi", "recipientEmail": "r@x.co"}
        if ok:
            PurchaseRequest.model_validate(data)
        else:
            _fails(PurchaseRequest, data, "amount")

    def test_issue_amount_ceiling_is_lower(self):
        data = {"recipientName": "R", "recipientEmail": "r@x.co", "reason": "goodwill"}
        IssueRequest.model_validate({**data, "amount": 100_000})
        _fails(IssueRequest, {**data, "amount": 100_001}, "amount")

    @pytest.mark.parametrize("kind", ["grant", "goodwill", "promotion", "revoke"])
    def test_credit_kinds(self, kind):
        CreditAdjustRequest.model_validate({"kind": kind, "amount": 1, "reason": "r"})

    def test_unknown_credit_kind(self):
        _fails(CreditAdjustRequest, {"kind": "steal", "amount": 1, "reason": "r"}, "kind")

    def test_points_adjust(self):
        PointsAdjustRequest.model_validate({"kind": "manual_debit", "points": 1, "reason": "r"})
        _fails(PointsAdjustRequest, {"kind": "manual_debit", "points": 0, "reason": "r"}, "points")
        _fails(PointsAdjustRequest, {"kind": "gift", "points": 1, "reason": "r"}, "kind")

    def test_tender_preview(self):
        assert TenderPreviewRequest.model_validate({}).points == 0
        _fails(TenderPreviewRequest, {"points": -1})
        _fails(TenderPreviewRequest, {"giftCardCodes": ["A"] * 6})


class TestMessagingAndStock:
    def test_token_in_bounds(self):
        _fails(TokenIn, {"token": "short"})
        TokenIn.model_validate({"token": "t" * 10})

    def test_click_in(self):
        ClickIn.model_validate({"token": "abcd", "to": "https://x", "s": "sig"})
        _fails(ClickIn, {"token": "abc", "to": "https://x", "s": "sig"}, "token")

    def test_test_in(self):
        _fails(MessagingTestIn, {"channel": "sms", "recipient": "12"}, "recipient")

    def test_stock_update(self):
        StockUpdate.model_validate({"quantity": 0})
        _fails(StockUpdate, {"quantity": -1}, "quantity")
