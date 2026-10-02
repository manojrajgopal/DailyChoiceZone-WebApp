"""
Email: variable substitution, the HTML sanitiser, the layout components, and
the two ways mail leaves (Gmail's API and SMTP).

Gmail is reached through `httpx.post` and SMTP through `smtplib`; both are
replaced with fakes so no mail is sent and no network is touched.
"""

from __future__ import annotations

import smtplib

import httpx
import pytest

from app.core.config import settings
from app.services.email import senders, templates
from app.services.email.senders import SendError
from app.services.email.templates import TemplateError


# --------------------------------------------------------------- variables


class TestRender:
    def test_variables_in(self):
        assert templates.variables_in("Hi {{ name }}, order {{order}} {{name}}") == ["name", "order"]
        assert templates.variables_in("") == []
        assert templates.variables_in(None) == []

    def test_unknown_variables(self):
        assert templates.unknown_variables("{{a}} {{b}}", ["a"]) == ["b"]

    def test_plain_substitution(self):
        assert templates.render("Hi {{name}}!", {"name": "Asha"}, allowed=["name"]) == "Hi Asha!"

    def test_known_variable_without_a_value_is_empty(self):
        assert templates.render("[{{name}}]", {}, allowed=["name"]) == "[]"
        assert templates.render("[{{n}}]", {"n": None}, allowed=["n"]) == "[]"

    def test_non_string_values_are_stringified(self):
        assert templates.render("{{n}}", {"n": 5}, allowed=["n"]) == "5"

    def test_unknown_variable_is_refused(self):
        with pytest.raises(TemplateError, match="Unknown variable: secret"):
            templates.render("{{secret}}", {}, allowed=["name"])

    def test_several_unknown_variables_are_all_named(self):
        with pytest.raises(TemplateError, match="Unknown variables: a, b"):
            templates.render("{{a}}{{b}}", {}, allowed=[])

    def test_expressions_are_not_variables(self):
        """`{{ user.password }}` is not a placeholder; it stays as text."""
        assert templates.render("{{ user.password }}", {}, allowed=[]) == "{{ user.password }}"

    def test_plain_text_mode_does_not_escape(self):
        assert templates.render("{{n}}", {"n": "<b>"}, allowed=["n"]) == "<b>"

    def test_html_mode_escapes_values(self):
        out = templates.render("Hi {{name}}", {"name": "<script>alert(1)</script>"}, allowed=["name"], html=True)
        assert "<script>" not in out
        assert "&lt;script&gt;" in out

    def test_html_mode_escapes_the_template_text_too(self):
        out = templates.render("a < b & c", {}, allowed=[], html=True)
        assert "a &lt; b &amp; c" in out

    def test_html_mode_paragraphs_line_breaks_and_bold(self):
        out = templates.render("**Hello** {{n}}\nline two\n\nsecond", {"n": "x"}, allowed=["n"], html=True)
        assert out.count("<p ") == 2
        assert "<strong>Hello</strong>" in out
        assert "line two" in out and "<br>" in out

    def test_bold_markers_in_a_value_are_not_formatted(self):
        """A customer named **X** gets asterisks, not bold, where the value goes in."""
        out = templates.render("{{n}}", {"n": "**X**"}, allowed=["n"], html=True)
        assert "<strong>" not in out


# --------------------------------------------------------------- sanitiser


class TestSanitise:
    def test_keeps_allowed_formatting_with_house_styles(self):
        out = templates.sanitise_html("<p>Hello <strong>you</strong></p>")
        assert out.startswith('<p style="') and "<strong>you</strong></p>" in out

    @pytest.mark.parametrize("tag", ["script", "style", "iframe", "object", "embed", "form", "title"])
    def test_drops_dangerous_blocks_and_their_contents(self, tag):
        out = templates.sanitise_html(f"<p>a</p><{tag}>evil()</{tag}><p>b</p>")
        assert "evil" not in out and f"<{tag}" not in out
        assert "a" in out and "b" in out

    def test_drops_event_handlers_and_unknown_attributes(self):
        out = templates.sanitise_html('<a href="https://x.test" onclick="steal()" class="c">go</a>')
        assert "onclick" not in out and "class" not in out
        assert 'href="https://x.test"' in out

    @pytest.mark.parametrize("url", ["javascript:alert(1)", "data:text/html,xx", "vbscript:x"])
    def test_drops_unsafe_links(self, url):
        out = templates.sanitise_html(f'<a href="{url}">x</a><img src="{url}">')
        assert url.split(":")[0] not in out

    @pytest.mark.parametrize("url", ["https://a.test", "http://a.test", "mailto:a@b.test", "/relative"])
    def test_keeps_safe_links(self, url):
        assert f'href="{url}"' in templates.sanitise_html(f'<a href="{url}">x</a>')

    def test_unknown_tags_are_unwrapped_not_their_text(self):
        assert templates.sanitise_html("<div><marquee>hi</marquee></div>") == "hi"

    def test_void_tags_are_self_closed_and_not_closed_again(self):
        out = templates.sanitise_html("a<br>b<hr>")
        assert "<br />" in out and "</br>" not in out and "</hr>" not in out

    def test_text_is_escaped(self):
        assert templates.sanitise_html("1 < 2") == "1 &lt; 2"

    def test_attribute_values_are_escaped(self):
        out = templates.sanitise_html('<img src="https://a.test/x.png" alt="&quot;><script>">')
        assert "<script>" not in out

    def test_empty(self):
        assert templates.sanitise_html("") == ""
        assert templates.sanitise_html(None) == ""

    def test_text_from_html(self):
        text = templates.text_from_html("<h2>Hi</h2><p>One &amp; two</p><p>Three<br>Four</p>\n\n\n\n")
        assert text == "Hi\nOne & two\nThree\nFour"
        assert templates.text_from_html("") == ""


# -------------------------------------------------------------- components


@pytest.fixture()
def plain_brand(monkeypatch):
    brand = {"name": "Daily Choice Zone", "url": "https://shop.test", "tagline": "", "supportEmail": "",
             "supportPhone": "", "supportHours": "", "social": [], "logo": "https://shop.test/brand/logo.png"}
    monkeypatch.setattr(templates, "brand", lambda: dict(brand))
    return brand


class TestComponents:
    def test_paragraph_escapes_unless_raw(self):
        assert "&lt;b&gt;" in templates.paragraph("<b>")
        assert "<b>" in templates.paragraph("<b>", raw=True)

    def test_button_escapes_label_and_url(self):
        out = templates.button("<Go>", 'https://x.test/?a="b"')
        assert "&lt;Go&gt;" in out and "&quot;b&quot;" in out

    def test_details_empty_is_nothing(self):
        assert templates.details([]) == ""

    def test_details_rows(self):
        out = templates.details([("Order", "<ORD001>"), ("Total", "<b>1</b>")], raw_values=False)
        assert "&lt;ORD001&gt;" in out
        assert "<b>1</b>" in templates.details([("Total", "<b>1</b>")], raw_values=True)

    def test_items_with_image_detail_and_total(self):
        out = templates.items(
            [{"name": "Kurta", "detail": "Size M", "quantity": 2, "amount": "Rs 2,000",
              "image": "https://cdn.test/k.jpg"},
             {"name": "No image", "image": "/local.jpg"}],
            total="Rs 2,000",
        )
        assert "https://cdn.test/k.jpg" in out
        assert "/local.jpg" not in out  # only absolute images are shown
        assert "Size M" in out and "Qty 2" in out and "Qty 1" in out
        assert "Total" in out

    def test_items_without_total(self):
        assert "Total" not in templates.items([{"name": "A"}])

    def test_note(self):
        assert "&lt;" in templates.note("<")
        assert "<em>" in templates.note("<em>x</em>", raw=True)


class TestMaster:
    def test_frame_contains_title_body_and_store(self, plain_brand):
        html = templates.master(title="Your <order>", intro_html="Thanks", body_html="<p>Body</p>",
                                cta=("Track", "https://shop.test/t"), preheader="pre")
        assert "Your &lt;order&gt;" in html
        assert "<p>Body</p>" in html
        assert "Track" in html and "https://shop.test/t" in html
        assert "Daily Choice Zone" in html
        assert "help centre" in html  # no contact details -> link to support

    def test_transactional_email_has_no_unsubscribe(self, plain_brand):
        html = templates.master(title="t", unsubscribe_url="https://shop.test/u")
        assert "Unsubscribe" not in html
        assert "activity on your account" in html

    def test_marketing_email_has_unsubscribe_and_preferences(self, plain_brand):
        html = templates.master(title="t", marketing=True, unsubscribe_url="https://shop.test/u",
                                preferences_url="https://shop.test/p", tracking_pixel="https://api.test/o.gif")
        assert "Unsubscribe" in html and "Email preferences" in html
        assert "chose to hear about offers" in html
        assert "https://api.test/o.gif" in html

    def test_preferences_link_alone(self, plain_brand):
        html = templates.master(title="t", preferences_url="https://shop.test/p")
        assert "Email preferences" in html and "Unsubscribe" not in html

    def test_contact_details_and_social_links(self, plain_brand):
        plain_brand.update(supportEmail="help@shop.test", supportPhone="+91 1", supportHours="9-6",
                           tagline="Choose well", social=[("Instagram", "https://ig.test/dcz")])
        html = templates.master(title="t", footnote="Custom footnote")
        assert "mailto:help@shop.test" in html and "+91 1" in html and "9-6" in html
        assert "https://ig.test/dcz" in html and "Choose well" in html
        assert "Custom footnote" in html

    def test_intro_that_is_already_a_block_is_not_wrapped(self, plain_brand):
        html = templates.master(title="t", intro_html="<table id='x'></table>")
        assert "<table id='x'></table>" in html
        # Wrapped would read `...color:#524b45"><table id='x'>`.
        assert "\"><table id='x'>" not in html

    def test_plain_intro_is_wrapped_in_a_paragraph(self, plain_brand):
        assert "\">Thanks for shopping</p>" in templates.master(title="t", intro_html="Thanks for shopping")


class TestBrand:
    def test_falls_back_when_settings_cannot_be_read(self, monkeypatch):
        templates.forget_brand()
        import app.services.billing as billing

        monkeypatch.setattr(billing, "store_settings", lambda db: (_ for _ in ()).throw(RuntimeError("down")))
        value = templates.brand()
        assert value["name"] == "Daily Choice Zone"
        assert value["logo"].endswith("/brand/logo.png")
        templates.forget_brand()

    def test_reads_the_store_settings_and_caches(self, monkeypatch):
        templates.forget_brand()
        import app.services.billing as billing

        calls = []

        def store(db):
            calls.append(1)
            return {"general": {"storeName": "DCZ", "tagline": "t"},
                    "contact": {"email": "e@x.test", "phone": "1", "supportHours": "h"},
                    "social": {"instagram": "https://ig.test", "facebook": ""}}

        monkeypatch.setattr(billing, "store_settings", store)
        first = templates.brand()
        second = templates.brand()
        assert first["name"] == "DCZ" and first["supportEmail"] == "e@x.test"
        assert first["social"] == [("Instagram", "https://ig.test")]
        assert second == first and len(calls) == 1
        templates.forget_brand()


class TestEmbedLogo:
    def test_html_without_the_logo_link_is_unchanged(self):
        assert templates.embed_logo("<p>hi</p>") == ("<p>hi</p>", None)

    def test_logo_link_becomes_an_inline_attachment(self, monkeypatch, tmp_path):
        logo = tmp_path / "logo.png"
        logo.write_bytes(b"\x89PNG")
        monkeypatch.setattr(templates, "LOGO_FILE", logo)
        link = f'src="{settings.STOREFRONT_URL.rstrip("/")}/brand/logo.png"'
        html, data = templates.embed_logo(f"<img {link}>")
        assert 'src="cid:dcz-logo"' in html and data == b"\x89PNG"

    def test_missing_logo_file_leaves_the_link(self, monkeypatch, tmp_path):
        monkeypatch.setattr(templates, "LOGO_FILE", tmp_path / "missing.png")
        link = f'src="{settings.STOREFRONT_URL.rstrip("/")}/brand/logo.png"'
        assert templates.embed_logo(f"<img {link}>") == (f"<img {link}>", None)


# ----------------------------------------------------------------- senders


class TestBuildMessage:
    def test_headers_and_parts(self):
        message = senders.build_message(sender_email="shop@dcz.test", sender_name="DCZ", reply_to="help@dcz.test",
                                        to="a@b.test", subject="Hello", html="<p>Hi</p>", text="Hi")
        assert message["From"] == "DCZ <shop@dcz.test>"
        assert message["To"] == "a@b.test"
        assert message["Subject"] == "Hello"
        assert message["Reply-To"] == "help@dcz.test"
        assert "@dcz.test>" in message["Message-ID"]
        kinds = [part.get_content_type() for part in message.iter_parts()]
        assert kinds == ["text/plain", "text/html"]

    def test_without_name_or_reply_to(self):
        message = senders.build_message(sender_email="shop@dcz.test", sender_name="", reply_to="", to="a@b.test",
                                        subject="s", html="<p></p>", text="")
        assert message["From"] == "shop@dcz.test"
        assert message["Reply-To"] is None


class FakeResponse:
    def __init__(self, status: int, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


@pytest.fixture()
def gmail(monkeypatch):
    senders._tokens.clear()
    script = []
    calls = []

    def post(url, **kwargs):
        calls.append((url, kwargs))
        outcome = script.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(senders.httpx, "post", post)
    yield script, calls
    senders._tokens.clear()


CREDS = {"clientId": "cid", "clientSecret": "csec", "refreshToken": "rt"}


class TestGmailToken:
    def test_refreshes_and_caches(self, gmail):
        script, calls = gmail
        script.append(FakeResponse(200, {"access_token": "at1", "expires_in": 3600}))
        assert senders.gmail_access_token(CREDS) == "at1"
        assert senders.gmail_access_token(CREDS) == "at1"
        assert len(calls) == 1
        assert calls[0][1]["data"]["grant_type"] == "refresh_token"

    def test_force_refreshes_again(self, gmail):
        script, calls = gmail
        script += [FakeResponse(200, {"access_token": "a"}), FakeResponse(200, {"access_token": "b"})]
        senders.gmail_access_token(CREDS)
        assert senders.gmail_access_token(CREDS, force=True) == "b"

    def test_a_given_access_token_without_refresh_token_is_used_as_is(self, gmail):
        assert senders.gmail_access_token({"accessToken": "given"}) == "given"

    def test_incomplete_credentials_with_a_token_fall_back_to_it(self, gmail):
        assert senders.gmail_access_token({"refreshToken": "rt", "accessToken": "given"}) == "given"

    def test_incomplete_credentials_are_refused(self, gmail):
        with pytest.raises(SendError, match="client ID"):
            senders.gmail_access_token({})

    def test_network_failure(self, gmail):
        gmail[0].append(httpx.ConnectError("down"))
        with pytest.raises(SendError, match="Couldn't reach Google"):
            senders.gmail_access_token(CREDS)

    @pytest.mark.parametrize(
        "status, body, fragment",
        [
            (400, {"error": "invalid_grant"}, "refresh token"),
            (401, {"error": "invalid_client"}, "client ID or client secret"),
            (400, {"error": "unauthorized_client"}, "isn't allowed"),
            (403, {"error": {"status": "PERMISSION_DENIED", "message": "x"}}, "gmail.send"),
            (400, {"error": {"status": "INVALID", "message": "bad thing"}}, "bad thing"),
            (500, {"error_description": "server sad"}, "server sad"),
            (502, ValueError("not json"), "Google answered 502"),
        ],
    )
    def test_google_errors_are_explained(self, gmail, status, body, fragment):
        gmail[0].append(FakeResponse(status, body))
        with pytest.raises(SendError, match=fragment):
            senders.gmail_access_token(CREDS)


class TestSendGmail:
    def _message(self):
        return senders.build_message(sender_email="s@dcz.test", sender_name="", reply_to="", to="a@b.test",
                                     subject="s", html="<p>x</p>", text="x")

    def test_success_returns_the_message_id(self, gmail):
        script, calls = gmail
        script += [FakeResponse(200, {"access_token": "at"}), FakeResponse(200, {"id": "msg-1"})]
        assert senders.send_gmail(CREDS, self._message()) == "msg-1"
        assert calls[1][0] == senders.SEND_URL
        assert calls[1][1]["headers"] == {"Authorization": "Bearer at"}
        assert "raw" in calls[1][1]["json"]

    def test_expired_token_is_refreshed_once_and_retried(self, gmail):
        script, calls = gmail
        script += [FakeResponse(200, {"access_token": "old"}), FakeResponse(401, {}),
                   FakeResponse(200, {"access_token": "new"}), FakeResponse(202, {"id": "m2"})]
        assert senders.send_gmail(CREDS, self._message()) == "m2"
        assert calls[3][1]["headers"]["Authorization"] == "Bearer new"

    def test_second_401_gives_up(self, gmail):
        script, _ = gmail
        script += [FakeResponse(200, {"access_token": "a"}), FakeResponse(401, {}),
                   FakeResponse(200, {"access_token": "b"}), FakeResponse(401, {"error": {"message": "no"}})]
        with pytest.raises(SendError):
            senders.send_gmail(CREDS, self._message())

    def test_network_failure_while_sending(self, gmail):
        script, _ = gmail
        script += [FakeResponse(200, {"access_token": "a"}), httpx.ReadTimeout("slow")]
        with pytest.raises(SendError, match="Couldn't reach Gmail"):
            senders.send_gmail(CREDS, self._message())


class TestExchangeCode:
    def test_success(self, gmail):
        gmail[0].append(FakeResponse(200, {"refresh_token": "r", "access_token": "a"}))
        assert senders.exchange_code(client_id="c", client_secret="s", code="x", redirect_uri="u") == {
            "refreshToken": "r", "accessToken": "a"}
        assert gmail[1][0][1]["data"]["grant_type"] == "authorization_code"

    def test_no_refresh_token_asks_for_consent_again(self, gmail):
        gmail[0].append(FakeResponse(200, {"access_token": "a"}))
        with pytest.raises(SendError, match="refresh token"):
            senders.exchange_code(client_id="c", client_secret="s", code="x", redirect_uri="u")

    def test_error_and_network_failure(self, gmail):
        gmail[0].extend([FakeResponse(400, {"error": "invalid_grant"}), httpx.ConnectError("x")])
        with pytest.raises(SendError):
            senders.exchange_code(client_id="c", client_secret="s", code="x", redirect_uri="u")
        with pytest.raises(SendError, match="Couldn't reach Google"):
            senders.exchange_code(client_id="c", client_secret="s", code="x", redirect_uri="u")


class FakeSMTP:
    instances = []

    def __init__(self, host, port, timeout=None, context=None, fail=None):
        self.host, self.port, self.log = host, port, []
        self.fail = FakeSMTP.fail_with
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self, context=None):
        self.log.append("starttls")

    def login(self, user, password):
        self.log.append(("login", user, password))
        if isinstance(self.fail, smtplib.SMTPAuthenticationError):
            raise self.fail

    def send_message(self, message):
        if self.fail and not isinstance(self.fail, smtplib.SMTPAuthenticationError):
            raise self.fail
        self.log.append("sent")


@pytest.fixture()
def smtp(monkeypatch):
    FakeSMTP.instances = []
    FakeSMTP.fail_with = None
    monkeypatch.setattr(senders.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(senders.smtplib, "SMTP_SSL", FakeSMTP)
    return FakeSMTP


class TestSendSmtp:
    def _message(self):
        return senders.build_message(sender_email="s@dcz.test", sender_name="", reply_to="", to="a@b.test",
                                     subject="s", html="<p>x</p>", text="x")

    def test_starttls_with_login(self, smtp):
        message = self._message()
        result = senders.send_smtp({"host": "smtp.test", "username": "u", "password": "p"}, message)
        server = smtp.instances[0]
        assert (server.host, server.port) == ("smtp.test", 587)
        assert server.log == ["starttls", ("login", "u", "p"), "sent"]
        assert result == message["Message-ID"]

    def test_ssl_without_login(self, smtp):
        senders.send_smtp({"host": "smtp.test", "port": "465", "security": "ssl"}, self._message())
        server = smtp.instances[0]
        assert server.port == 465 and server.log == ["sent"]

    def test_no_security(self, smtp):
        senders.send_smtp({"host": "smtp.test", "security": "none"}, self._message())
        assert "starttls" not in smtp.instances[0].log

    def test_host_is_required(self, smtp):
        with pytest.raises(SendError, match="SMTP server address"):
            senders.send_smtp({}, self._message())

    def test_bad_credentials(self, smtp):
        smtp.fail_with = smtplib.SMTPAuthenticationError(535, b"no")
        with pytest.raises(SendError, match="username or password"):
            senders.send_smtp({"host": "h", "username": "u"}, self._message())

    @pytest.mark.parametrize("error", [smtplib.SMTPRecipientsRefused({}), ConnectionRefusedError()])
    def test_other_failures_name_only_the_error_class(self, smtp, error):
        smtp.fail_with = error
        with pytest.raises(SendError, match=type(error).__name__):
            senders.send_smtp({"host": "h"}, self._message())


class TestDeliver:
    def _message(self):
        return senders.build_message(sender_email="s@dcz.test", sender_name="", reply_to="", to="a@b.test",
                                     subject="s", html="<p>x</p>", text="x")

    def test_undeliverable_address_is_refused_before_sending(self, monkeypatch):
        monkeypatch.setattr(senders, "undeliverable", lambda address: "No such domain.")
        with pytest.raises(SendError, match="No such domain"):
            senders.deliver("smtp", {"host": "h"}, self._message())

    def test_routes_by_provider(self, monkeypatch):
        monkeypatch.setattr(senders, "send_gmail", lambda c, m: "g")
        monkeypatch.setattr(senders, "send_smtp", lambda c, m: "s")
        assert senders.deliver("gmail-oauth", {}, self._message()) == "g"
        assert senders.deliver("smtp", {}, self._message()) == "s"
        with pytest.raises(SendError, match="Choose how"):
            senders.deliver("carrier-pigeon", {}, self._message())


class TestConsentUrl:
    def test_contains_the_scopes_and_offline_access(self):
        url = senders.consent_url(client_id="cid", redirect_uri="https://api.test/cb", state="s1",
                                  login_hint="a@b.test")
        assert url.startswith(senders.AUTH_URL + "?")
        assert "client_id=cid" in url and "access_type=offline" in url and "prompt=consent" in url
        assert "gmail.send" in url and "gmail.readonly" in url
        assert "login_hint=a%40b.test" in url and "state=s1" in url

    def test_without_login_hint(self):
        assert "login_hint" not in senders.consent_url(client_id="c", redirect_uri="u", state="s")


class TestCheckDomain:
    """DNS is faked; the real resolver is never asked."""

    @pytest.fixture()
    def dns(self, monkeypatch):
        import dns.exception
        import dns.resolver

        senders._domains.clear()
        answers: dict = {}

        class Record:
            def __init__(self, exchange):
                self.exchange = exchange

        class Resolver:
            lifetime = 0

            def resolve(self, domain, kind):
                outcome = answers.get((domain, kind), dns.resolver.NoAnswer())
                if isinstance(outcome, Exception):
                    raise outcome
                return [Record(x) for x in outcome]

        monkeypatch.setattr(dns.resolver, "Resolver", Resolver)
        yield answers, dns
        senders._domains.clear()

    def test_no_domain(self, dns):
        assert "no domain" in senders.check_domain("nobody@")

    def test_domain_with_mx_is_fine_and_cached(self, dns):
        answers, _ = dns
        answers[("good.test", "MX")] = ["mx.good.test."]
        assert senders.check_domain("a@Good.Test") == ""
        answers[("good.test", "MX")] = dns[1].resolver.NXDOMAIN()
        assert senders.check_domain("a@good.test") == ""  # cached

    def test_null_mx(self, dns):
        dns[0][("null.test", "MX")] = ["."]
        assert "null MX" in senders.check_domain("a@null.test")

    def test_nxdomain(self, dns):
        dns[0][("gone.test", "MX")] = dns[1].resolver.NXDOMAIN()
        assert "doesn't exist" in senders.check_domain("a@gone.test")

    def test_no_mx_but_an_address_record(self, dns):
        dns[0][("a.test", "A")] = ["1.2.3.4"]
        assert senders.check_domain("x@a.test") == ""

    def test_no_mx_no_a_but_aaaa(self, dns):
        dns[0][("v6.test", "AAAA")] = ["::1"]
        assert senders.check_domain("x@v6.test") == ""

    def test_no_mail_server_at_all(self, dns):
        assert "no mail server" in senders.check_domain("x@empty.test")

    def test_resolver_trouble_is_not_held_against_the_address(self, dns):
        answers, d = dns
        answers[("slow.test", "MX")] = d.exception.Timeout()
        assert senders.check_domain("x@slow.test") == ""
        answers[("slow2.test", "A")] = d.exception.Timeout()
        assert senders.check_domain("x@slow2.test") == ""
        answers[("slow3.test", "AAAA")] = d.exception.Timeout()
        assert senders.check_domain("x@slow3.test") == ""
