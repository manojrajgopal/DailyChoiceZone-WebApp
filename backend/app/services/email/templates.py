"""
The email design system: one branded master layout, the pieces emails are
built from, and a safe way to fill in variables.

## The master layout

`master()` is every email's frame — the logo and store name, the title and
message, an optional button, and a footer with how to reach the store, the
website, policies, social links and (for marketing only) an unsubscribe link.

Written for email clients, not browsers:

- **Tables for structure**, because Outlook on Windows renders with Word and
  ignores most layout CSS; a fixed-width "ghost table" in Outlook-only
  comments keeps it at 600px there.
- **Styles inline on every element**, because Gmail and many webmail clients
  strip or ignore `<style>` blocks in some contexts. The `<style>` block only
  *adds* things clients that support it can use: the phone-width layout, dark
  mode colours, link resets.
- **Buttons are padded links in a table cell**, with a VML shape for Outlook,
  so they're clickable everywhere and look like buttons where possible.
- **System fonts** (Georgia for headings, Helvetica/Arial for text), because
  web fonts load in few clients.
- **The logo is the website's own** (`frontend/public/brand/logo.png`). Sent
  mail carries it as an inline attachment (`embed_logo`), so it shows even
  when the storefront isn't reachable by mail clients; previews link to it.
  The store name is its alt text and is set in text beside it — so an email
  with images blocked still says who it's from.

## Variables

Admin-editable wording uses `{{variable}}` placeholders and nothing else — no
expressions, loops, attribute access or code. `render()` substitutes only
names on the template's allowed list, refuses unknown ones, and HTML-escapes
every value going into HTML, so a customer who names themselves
`<script>` gets their name printed, not run.
"""

from __future__ import annotations

import html as html_lib
import re
import time
from html.parser import HTMLParser
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from app.core.config import settings

esc = html_lib.escape

# The palette, from the storefront's brand: ink, cream and copper.
INK = "#1e1b18"
INK_SOFT = "#524b45"
MUTED = "#8a817a"
LINE = "#ede7df"
CREAM = "#f5f1eb"
CREAM_LIGHT = "#faf7f2"
COPPER = "#a4562f"
WHITE = "#ffffff"
FONT = "Helvetica, Arial, sans-serif"
SERIF = "Georgia, 'Times New Roman', serif"

_VARIABLE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
_BRAND_CACHE: Dict[str, object] = {"at": 0.0, "value": None}
_BRAND_TTL = 60


class TemplateError(ValueError):
    """A template names a variable it may not use, or is otherwise invalid."""


# ---------------------------------------------------------------- variables


def variables_in(template: str) -> List[str]:
    return sorted({match.group(1) for match in _VARIABLE.finditer(template or "")})


def unknown_variables(template: str, allowed: Iterable[str]) -> List[str]:
    allowed = set(allowed)
    return [name for name in variables_in(template) if name not in allowed]


def render(template: str, values: Dict[str, object], *, allowed: Iterable[str], html: bool = False) -> str:
    """
    Fill `{{name}}` placeholders. Unknown names are refused; a known name with
    no value becomes empty. With `html=True` the template is plain text that
    becomes HTML: it is escaped, blank lines become paragraphs, `**text**`
    becomes bold — and every value is escaped as it goes in.
    """
    unknown = unknown_variables(template, allowed)
    if unknown:
        raise TemplateError(f"Unknown variable{'s' if len(unknown) > 1 else ''}: {', '.join(unknown)}")

    def value_of(match: re.Match) -> str:
        value = values.get(match.group(1))
        text = "" if value is None else str(value)
        return esc(text) if html else text

    if not html:
        return _VARIABLE.sub(value_of, template or "")
    # Escape the template's own text first, then put the (escaped) values in.
    pieces, last = [], 0
    for match in _VARIABLE.finditer(template or ""):
        pieces.append(esc(template[last:match.start()]))
        pieces.append("\x00" + match.group(0) + "\x01")
        last = match.end()
    pieces.append(esc((template or "")[last:]))
    escaped = "".join(pieces)
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"\x00(\{\{.*?\}\})\x01", lambda m: _VARIABLE.sub(value_of, m.group(1)), escaped)
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", escaped) if p.strip()]
    return "".join(paragraph(p.replace("\n", "<br>"), raw=True) for p in paragraphs)


# ------------------------------------------------------- safe campaign HTML

ALLOWED_TAGS = {
    "p": set(), "br": set(), "strong": set(), "b": set(), "em": set(), "i": set(), "u": set(),
    "h2": set(), "h3": set(), "ul": set(), "ol": set(), "li": set(), "blockquote": set(),
    "a": {"href", "title"}, "img": {"src", "alt", "width", "height"}, "hr": set(), "span": set(),
}
_SAFE_URL = re.compile(r"^(https?://|mailto:|/)", re.I)
_TAG_STYLE = {
    "p": f"margin:0 0 16px;font-family:{FONT};font-size:15px;line-height:1.65;color:{INK_SOFT}",
    "h2": f"margin:24px 0 10px;font-family:{SERIF};font-weight:normal;font-size:21px;line-height:1.3;color:{INK}",
    "h3": f"margin:20px 0 8px;font-family:{FONT};font-size:16px;font-weight:bold;color:{INK}",
    "ul": f"margin:0 0 16px;padding-left:22px;font-family:{FONT};font-size:15px;line-height:1.65;color:{INK_SOFT}",
    "ol": f"margin:0 0 16px;padding-left:22px;font-family:{FONT};font-size:15px;line-height:1.65;color:{INK_SOFT}",
    "a": f"color:{COPPER};text-decoration:underline",
    "img": "display:block;max-width:100%;height:auto;border:0;margin:0 0 16px",
    "blockquote": f"margin:0 0 16px;padding:12px 16px;border-left:3px solid {COPPER};background:{CREAM_LIGHT};color:{INK_SOFT}",
    "hr": f"border:0;border-top:1px solid {LINE};margin:24px 0",
}


class _Sanitiser(HTMLParser):
    """Keeps a small set of formatting tags, drops everything else (scripts, styles, event handlers)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: List[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "iframe", "object", "embed", "form", "head", "title"):
            self.skip += 1
            return
        if tag not in ALLOWED_TAGS or self.skip:
            return
        kept = []
        for name, value in attrs:
            if name not in ALLOWED_TAGS[tag] or value is None:
                continue
            if name in ("href", "src") and not _SAFE_URL.match(value.strip()):
                continue
            kept.append(f'{name}="{esc(value, quote=True)}"')
        if tag in _TAG_STYLE:
            kept.append(f'style="{_TAG_STYLE[tag]}"')
        closing = " /" if tag in ("br", "img", "hr") else ""
        self.out.append(f"<{tag}{(' ' + ' '.join(kept)) if kept else ''}{closing}>")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "iframe", "object", "embed", "form", "head", "title"):
            self.skip = max(0, self.skip - 1)
            return
        if tag in ALLOWED_TAGS and tag not in ("br", "img", "hr") and not self.skip:
            self.out.append(f"</{tag}>")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(esc(data))


def sanitise_html(markup: str) -> str:
    parser = _Sanitiser()
    parser.feed(markup or "")
    parser.close()
    return "".join(parser.out)


def text_from_html(markup: str) -> str:
    """A plain-text version of an HTML body, for the text part and SMS fallbacks."""
    text = re.sub(r"<(br|/p|/h2|/h3|/li)\s*/?>", "\n", markup or "", flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\n{3,}", "\n\n", html_lib.unescape(text)).strip()


# ------------------------------------------------------------- the brand

# The logo the website shows; sent mail carries a copy of it.
LOGO_FILE = Path(__file__).resolve().parents[4] / "frontend" / "public" / "brand" / "logo.png"
LOGO_CID = "dcz-logo"


def embed_logo(html: str) -> tuple:
    """
    Point the email's logo at an inline copy of the website's logo file, so
    mail clients show it without loading the storefront (which may be
    localhost). Returns (html, png bytes) — or the html unchanged and None
    when the file isn't there, leaving the link to the storefront's logo.
    """
    link = f'src="{esc(settings.STOREFRONT_URL.rstrip("/") + "/brand/logo.png", quote=True)}"'
    if link not in html:
        return html, None
    try:
        data = LOGO_FILE.read_bytes()
    except OSError:
        return html, None
    return html.replace(link, f'src="cid:{LOGO_CID}"'), data



def brand() -> dict:
    """
    Name, address, logo, contact and links, from the store's settings (read
    at most once a minute). Falls back to the storefront address alone when
    the settings can't be read, so an email is never blocked on this.
    """
    now = time.monotonic()
    cached = _BRAND_CACHE.get("value")
    if cached is not None and now - float(_BRAND_CACHE["at"]) < _BRAND_TTL:
        return dict(cached)  # type: ignore[arg-type]
    url = settings.STOREFRONT_URL.rstrip("/")
    value = {
        "name": "Daily Choice Zone", "url": url, "tagline": "", "supportEmail": "", "supportPhone": "",
        "supportHours": "", "social": [],
        "logo": f"{url}/brand/logo.png",
    }
    try:
        from app.core.database import SessionLocal
        from app.services import billing

        db = SessionLocal()
        try:
            store = billing.store_settings(db)
        finally:
            if not db.info.get("test_session"):
                db.close()
        general, contact, social = store.get("general", {}), store.get("contact", {}), store.get("social", {})
        value.update({
            "name": general.get("storeName") or value["name"],
            "tagline": general.get("tagline", ""),
            "supportEmail": contact.get("email", ""),
            "supportPhone": contact.get("phone", ""),
            "supportHours": contact.get("supportHours", ""),
            "social": [(label, social.get(key)) for key, label in
                       (("instagram", "Instagram"), ("facebook", "Facebook"), ("youtube", "YouTube"))
                       if social.get(key)],
        })
    except Exception:  # noqa: BLE001 — the frame must never fail the email
        pass
    _BRAND_CACHE.update({"at": now, "value": value})
    return dict(value)


def forget_brand() -> None:
    _BRAND_CACHE.update({"at": 0.0, "value": None})


# ------------------------------------------------------------- components


def paragraph(text: str, *, raw: bool = False) -> str:
    return (f'<p style="margin:0 0 16px;font-family:{FONT};font-size:15px;line-height:1.65;color:{INK_SOFT}">'
            f"{text if raw else esc(text)}</p>")


def button(label: str, url: str) -> str:
    """A bulletproof button: a padded link in a cell, with a VML version for Outlook."""
    label, url = esc(label), esc(url, quote=True)
    return f"""<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 6px">
<tr><td align="center" bgcolor="{INK}" style="border-radius:4px;mso-padding-alt:0">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="{url}" style="height:46px;v-text-anchor:middle;width:240px" arcsize="9%" stroke="f" fillcolor="{INK}"><w:anchorlock/><center style="color:{CREAM_LIGHT};font-family:{FONT};font-size:14px;letter-spacing:1px">{label}</center></v:roundrect><![endif]-->
<!--[if !mso]><!-- --><a href="{url}" class="button" style="display:inline-block;padding:14px 28px;font-family:{FONT};font-size:14px;font-weight:bold;letter-spacing:.06em;line-height:18px;color:{CREAM_LIGHT};text-decoration:none;border-radius:4px;background:{INK};mso-hide:all">{label}</a><!--<![endif]-->
</td></tr></table>"""


def details(rows: Sequence[Tuple[str, str]], *, raw_values: bool = False) -> str:
    """A label/value box: order number, date, total, tracking."""
    if not rows:
        return ""
    cells = "".join(
        f'<tr><td class="stack" style="padding:9px 0;border-bottom:1px solid {LINE};font-family:{FONT};font-size:13px;'
        f'color:{MUTED};width:42%;vertical-align:top">{esc(label)}</td>'
        f'<td class="stack" style="padding:9px 0;border-bottom:1px solid {LINE};font-family:{FONT};font-size:14px;'
        f'color:{INK};text-align:right;vertical-align:top">{value if raw_values else esc(str(value))}</td></tr>'
        for label, value in rows
    )
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
            f'style="margin:18px 0 6px;border-top:1px solid {LINE}">{cells}</table>')


def items(lines: Sequence[dict], *, total: Optional[str] = None) -> str:
    """Product lines: name (and detail), quantity and amount, then a total."""
    rows = []
    for line in lines:
        image = (f'<img src="{esc(line["image"], quote=True)}" width="56" height="70" alt="" '
                 f'style="display:block;width:56px;height:70px;object-fit:cover;border-radius:3px;border:0">'
                 if line.get("image") and str(line["image"]).startswith("http") else "")
        rows.append(
            f'<tr>'
            + (f'<td width="68" style="padding:12px 12px 12px 0;border-bottom:1px solid {LINE};vertical-align:top">{image}</td>' if image else "")
            + f'<td style="padding:12px 0;border-bottom:1px solid {LINE};font-family:{FONT};font-size:14px;color:{INK};vertical-align:top">'
            f'{esc(line["name"])}'
            + (f'<span style="display:block;font-size:12px;color:{MUTED};margin-top:3px">{esc(line["detail"])}</span>' if line.get("detail") else "")
            + f'<span style="display:block;font-size:12px;color:{MUTED};margin-top:3px">Qty {esc(str(line.get("quantity", 1)))}</span></td>'
            f'<td align="right" style="padding:12px 0 12px 12px;border-bottom:1px solid {LINE};font-family:{FONT};font-size:14px;'
            f'color:{INK};vertical-align:top;white-space:nowrap">{esc(line.get("amount", ""))}</td></tr>'
        )
    footer = (f'<tr><td colspan="3" style="padding:14px 0 0;font-family:{FONT};font-size:15px;font-weight:bold;color:{INK}">'
              f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
              f'<td style="font-family:{FONT};font-size:15px;font-weight:bold;color:{INK}">Total</td>'
              f'<td align="right" style="font-family:{FONT};font-size:15px;font-weight:bold;color:{INK}">{esc(total)}</td>'
              f'</tr></table></td></tr>') if total else ""
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
            f'style="margin:20px 0 6px">{"".join(rows)}{footer}</table>')


def note(text: str, *, raw: bool = False) -> str:
    """A soft panel for something worth setting apart: a note from the team, a warning."""
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 6px">'
            f'<tr><td style="padding:14px 16px;background:{CREAM_LIGHT};border-left:3px solid {COPPER};'
            f'font-family:{FONT};font-size:14px;line-height:1.6;color:{INK_SOFT}">{text if raw else esc(text)}</td></tr></table>')


# ---------------------------------------------------------- master layout


def master(
    *,
    title: str,
    intro_html: str = "",
    body_html: str = "",
    cta: Optional[Tuple[str, str]] = None,
    footnote: str = "",
    preheader: str = "",
    marketing: bool = False,
    unsubscribe_url: str = "",
    preferences_url: str = "",
    tracking_pixel: str = "",
) -> str:
    """
    The whole email. `intro_html` and `body_html` are trusted HTML built by
    the server (with every customer value escaped); everything else is
    escaped here. The unsubscribe link appears only on marketing email.
    """
    b = brand()
    url = b["url"]
    name = esc(b["name"])
    pre = esc(preheader or "")
    intro = (f'<p style="margin:0 0 16px;font-family:{FONT};font-size:15px;line-height:1.65;color:{INK_SOFT}">{intro_html}</p>'
             if intro_html and not intro_html.lstrip().startswith(("<p", "<table", "<h2", "<ul", "<ol")) else intro_html)
    contact_bits = []
    if b.get("supportEmail"):
        contact_bits.append(f'<a href="mailto:{esc(b["supportEmail"], quote=True)}" style="color:{INK_SOFT};text-decoration:underline">{esc(b["supportEmail"])}</a>')
    if b.get("supportPhone"):
        contact_bits.append(esc(b["supportPhone"]))
    if b.get("supportHours"):
        contact_bits.append(esc(b["supportHours"]))
    contact = (f'<p style="margin:0 0 10px;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED}">'
               f'Questions? {" · ".join(contact_bits)}</p>') if contact_bits else (
        f'<p style="margin:0 0 10px;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED}">'
        f'Questions? <a href="{esc(url, quote=True)}/support" style="color:{INK_SOFT};text-decoration:underline">Visit our help centre</a></p>')
    link_style = f"color:{MUTED};text-decoration:underline"
    policies = " &nbsp;·&nbsp; ".join(
        f'<a href="{esc(url, quote=True)}{path}" style="{link_style}">{label}</a>'
        for label, path in (("Shop", "/"), ("Shipping", "/shipping"), ("Returns", "/returns"), ("Privacy", "/privacy"),
                            ("Terms", "/terms"))
    )
    social = (" &nbsp;·&nbsp; ".join(f'<a href="{esc(link, quote=True)}" style="{link_style}">{esc(label)}</a>'
                                     for label, link in b.get("social", []))) if b.get("social") else ""
    why = esc(footnote) if footnote else (
        "You're receiving this marketing email because you chose to hear about offers from us." if marketing else
        "You're receiving this because of activity on your account with us.")
    marketing_links = ""
    if marketing and unsubscribe_url:
        marketing_links = (f'<p style="margin:10px 0 0;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED}">'
                           f'<a href="{esc(unsubscribe_url, quote=True)}" style="{link_style}">Unsubscribe</a>'
                           + (f' &nbsp;·&nbsp; <a href="{esc(preferences_url, quote=True)}" style="{link_style}">Email preferences</a>' if preferences_url else "")
                           + "</p>")
    elif preferences_url:
        marketing_links = (f'<p style="margin:10px 0 0;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED}">'
                           f'<a href="{esc(preferences_url, quote=True)}" style="{link_style}">Email preferences</a></p>')
    pixel = (f'<img src="{esc(tracking_pixel, quote=True)}" width="1" height="1" alt="" '
             f'style="display:block;width:1px;height:1px;border:0;opacity:0">') if tracking_pixel else ""
    button_html = button(*cta) if cta else ""
    logo = esc(b["logo"], quote=True)

    return f"""<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{esc(title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  html, body {{ margin:0 !important; padding:0 !important; width:100% !important; }}
  * {{ -ms-text-size-adjust:100%; -webkit-text-size-adjust:100%; }}
  table, td {{ mso-table-lspace:0pt; mso-table-rspace:0pt; border-collapse:collapse; }}
  img {{ -ms-interpolation-mode:bicubic; border:0; outline:none; text-decoration:none; }}
  a[x-apple-data-detectors], .unstyle-auto-detected-links a {{ color:inherit !important; text-decoration:none !important; }}
  .button:hover {{ background:{COPPER} !important; }}
  @media screen and (max-width: 620px) {{
    .container {{ width:100% !important; max-width:100% !important; }}
    .pad {{ padding-left:20px !important; padding-right:20px !important; }}
    .title {{ font-size:22px !important; line-height:1.3 !important; }}
    .stack {{ display:block !important; width:100% !important; text-align:left !important; }}
    .button {{ display:block !important; text-align:center !important; }}
    .hide-mobile {{ display:none !important; }}
  }}
  @media (prefers-color-scheme: dark) {{
    .bg {{ background:#14110f !important; }}
    .card {{ background:#1e1b18 !important; }}
    .card p, .card td, .card h1, .card span {{ color:#ece6de !important; }}
    .footer {{ background:#191614 !important; }}
  }}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:{CREAM};word-spacing:normal">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:{CREAM}">{pre}&#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847;</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{CREAM}">
<tr><td align="center" style="padding:28px 12px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto">
  <tr><td class="pad" style="padding:0 32px 18px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="vertical-align:middle;padding-right:12px"><a href="{esc(url, quote=True)}" style="text-decoration:none"><img src="{logo}" width="48" height="48" alt="{name}" style="display:block;width:48px;height:48px;border-radius:24px;border:0;font-family:{FONT};font-size:12px;color:{INK}"></a></td>
      <td style="vertical-align:middle"><a href="{esc(url, quote=True)}" style="text-decoration:none;font-family:{SERIF};font-size:20px;line-height:1.2;color:{INK}">{name}</a>{f'<span style="display:block;font-family:{FONT};font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:{COPPER};margin-top:3px">{esc(b["tagline"])}</span>' if b.get("tagline") else ""}</td>
    </tr></table>
  </td></tr>
  <tr><td class="card" style="background:{WHITE};border-radius:6px;border-top:3px solid {COPPER}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td class="pad" style="padding:34px 40px 30px">
        <h1 class="title" style="margin:0 0 16px;font-family:{SERIF};font-weight:normal;font-size:26px;line-height:1.25;color:{INK}">{esc(title)}</h1>
        {intro}
        {body_html}
        {button_html}
      </td></tr>
    </table>
  </td></tr>
  <tr><td class="footer pad" style="padding:24px 40px 8px;font-family:{FONT};text-align:center">
    {contact}
    <p style="margin:0 0 10px;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED}">{policies}</p>
    {f'<p style="margin:0 0 10px;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED}">{social}</p>' if social else ""}
    <p style="margin:0;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED}">{why}</p>
    {marketing_links}
    <p style="margin:14px 0 0;font-family:{SERIF};font-size:13px;color:{INK_SOFT}"><a href="{esc(url, quote=True)}" style="color:{INK_SOFT};text-decoration:none">{name}</a></p>
    {pixel}
  </td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>"""
