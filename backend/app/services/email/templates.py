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

## The look

Light only (`color-scheme: light only`), on the storefront's palette: a
cream page, a white card with a copper rule, a banner tinted by the email's
`tone` (brand, success, warning, danger, info, celebrate) carrying an emoji
icon, then the body, a help strip, and an ink footer like the website's.

The body is built from the pieces below: `items` (photos, prices and the
money summary), `progress` (order or return steps), `cards` (address,
delivery, payment side by side), `details`, `stats`, `code_box`, `products`
(product cards), `steps` ("what happens next"), `quote` and `note`. Side-by-
side pieces stack into one column under 620px. A body that isn't HTML — a
list of pairs, say — is laid out as a details box by `body_from`, never
printed as a Python list.

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

# The palette, from the storefront's design tokens (frontend/src/app/globals.css):
# ink, cream and copper, with the logo's clay, sage leaf and blush for tone.
INK = "#1e1b18"
INK_SOFT = "#524b45"
MUTED = "#6b635c"
FAINT = "#8a817a"
LINE = "#ede7df"
CREAM = "#f5f1eb"
CREAM_DEEP = "#f4efe7"
CREAM_LIGHT = "#faf7f2"
SAND = "#f2e7dc"
COPPER = "#9c5d3d"
COPPER_BRIGHT = "#b5734f"
COPPER_SOFT = "#fbf4ef"
COPPER_PALE = "#dcac8d"
CLAY = "#a0522d"
CLAY_SOFT = "#fbf0ea"
SAGE = "#4a7a52"
SAGE_DEEP = "#2f5035"
SAGE_SOFT = "#eef3ea"
DANGER = "#9b3232"
DANGER_SOFT = "#f9eaea"
BLUSH_SOFT = "#f9e9e6"
WHITE = "#ffffff"
MONO = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace"

# A tone colours an email's banner and accents: (soft background, accent, deep text).
TONES = {
    "brand": (COPPER_SOFT, COPPER_BRIGHT, COPPER),
    "success": (SAGE_SOFT, SAGE, SAGE_DEEP),
    "warning": (CLAY_SOFT, CLAY, "#71391f"),
    "danger": (DANGER_SOFT, DANGER, DANGER),
    "info": (CREAM_DEEP, INK_SOFT, INK),
    "celebrate": (BLUSH_SOFT, COPPER_BRIGHT, COPPER),
}
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
#
# Every piece is a table (or sits in one) with its styles inline. Pieces that
# lay out side by side on a wide screen carry `class="stack"` on their cells,
# which the phone-width rules in `master` turn into full-width rows.


def _tone(tone: str) -> Tuple[str, str, str]:
    return TONES.get(tone or "brand", TONES["brand"])


def _table(inner: str, *, style: str = "", attrs: str = "") -> str:
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"{attrs} '
            f'style="{style}">{inner}</table>')


def paragraph(text: str, *, raw: bool = False) -> str:
    return (f'<p style="margin:0 0 16px;font-family:{FONT};font-size:15px;line-height:1.65;color:{INK_SOFT}">'
            f"{text if raw else esc(text)}</p>")


def heading(text: str, *, first: bool = False) -> str:
    """A section label: small, tracked capitals in copper over a hairline."""
    return (f'<p class="eyebrow" style="margin:{"0" if first else "30px"} 0 4px;padding:0 0 8px;border-bottom:1px solid {LINE};'
            f'font-family:{FONT};font-size:11px;font-weight:bold;letter-spacing:.16em;text-transform:uppercase;'
            f'color:{COPPER}">{esc(text)}</p>')


def button(label: str, url: str, *, tone: str = "") -> str:
    """A bulletproof button: a padded link in a cell, with a VML version for Outlook."""
    fill = _tone(tone)[1] if tone else INK
    label, url = esc(label), esc(url, quote=True)
    return f"""<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" class="button-wrap" style="margin:28px auto 6px">
<tr><td align="center" bgcolor="{fill}" style="border-radius:3px;mso-padding-alt:0">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="{url}" style="height:48px;v-text-anchor:middle;width:260px" arcsize="6%" stroke="f" fillcolor="{fill}"><w:anchorlock/><center style="color:{CREAM_LIGHT};font-family:{FONT};font-size:14px;font-weight:bold;letter-spacing:1px">{label}</center></v:roundrect><![endif]-->
<!--[if !mso]><!-- --><a href="{url}" class="button" style="display:inline-block;padding:15px 34px;font-family:{FONT};font-size:14px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;line-height:18px;color:{CREAM_LIGHT};text-decoration:none;border-radius:3px;background:{fill};mso-hide:all">{label}</a><!--<![endif]-->
</td></tr></table>"""


def badge(text: str, *, tone: str = "brand") -> str:
    """A small pill: a status, a saving, "Delivered"."""
    soft, accent, deep = _tone(tone)
    return (f'<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:{soft};'
            f'border:1px solid {accent};font-family:{FONT};font-size:11px;font-weight:bold;letter-spacing:.06em;'
            f'text-transform:uppercase;color:{deep};white-space:nowrap">{esc(text)}</span>')


def details(rows: Sequence[Tuple[str, str]], *, raw_values: bool = False, title: str = "") -> str:
    """A label/value box: order number, date, total, tracking."""
    rows = [(label, value) for label, value in rows if value not in (None, "")]
    if not rows:
        return ""
    last = len(rows) - 1
    cells = "".join(
        f'<tr><td class="stack" style="padding:11px 16px;{"" if i == last else f"border-bottom:1px solid {LINE};"}'
        f'font-family:{FONT};font-size:13px;color:{MUTED};width:42%;vertical-align:top">{esc(label)}</td>'
        f'<td class="stack stack-tight" style="padding:11px 16px;{"" if i == last else f"border-bottom:1px solid {LINE};"}'
        f'font-family:{FONT};font-size:14px;font-weight:bold;color:{INK};text-align:right;vertical-align:top">'
        f'{value if raw_values else esc(str(value))}</td></tr>'
        for i, (label, value) in enumerate(rows)
    )
    return (heading(title) if title else "") + _table(
        cells, attrs=' class="panel"',
        style=f"margin:18px 0 6px;background:{CREAM_LIGHT};border:1px solid {LINE};border-radius:4px;border-collapse:separate")


def _image(src: str, width: int, height: int, alt: str = "") -> str:
    return (f'<img src="{esc(src, quote=True)}" width="{width}" height="{height}" alt="{esc(alt, quote=True)}" '
            f'style="display:block;width:{width}px;height:{height}px;object-fit:cover;border-radius:3px;border:0;'
            f'background:{CREAM_DEEP};font-family:{FONT};font-size:10px;color:{FAINT}">')


def _usable_image(src) -> bool:
    return bool(src) and str(src).startswith(("http://", "https://"))


def items(lines: Sequence[dict], *, total: Optional[str] = None, summary: Sequence[tuple] = (),
          title: str = "", more: int = 0, more_url: str = "") -> str:
    """
    Product lines — photo, name (linked when the line has a `url`), detail,
    quantity and amount — then the money: `summary` rows of (label, value[,
    tone]) such as subtotal, discount and delivery, and the total.
    """
    rows = []
    for line in lines:
        name = esc(str(line.get("name", "")))
        if line.get("url"):
            name = f'<a href="{esc(line["url"], quote=True)}" style="color:{INK};text-decoration:none">{name}</a>'
        image_cell = (f'<td width="76" style="padding:14px 14px 14px 0;border-bottom:1px solid {LINE};vertical-align:top">'
                      f'{_image(line["image"], 64, 80, str(line.get("name", "")))}</td>') if _usable_image(line.get("image")) else ""
        meta = []
        if line.get("detail"):
            meta.append(esc(str(line["detail"])))
        meta.append(f'Qty {esc(str(line.get("quantity", 1)))}'
                    + (f' &times; {esc(str(line["unit"]))}' if line.get("unit") else ""))
        was = (f'<span style="display:block;font-size:12px;font-weight:normal;color:{FAINT};text-decoration:line-through">'
               f'{esc(str(line["was"]))}</span>') if line.get("was") else ""
        tag = f'<span style="display:block;margin-top:6px">{badge(line["badge"], tone=line.get("tone", "brand"))}</span>' if line.get("badge") else ""
        rows.append(
            f'<tr>{image_cell}'
            f'<td style="padding:14px 0;border-bottom:1px solid {LINE};font-family:{FONT};font-size:14px;line-height:1.45;'
            f'font-weight:bold;color:{INK};vertical-align:top">{name}'
            f'<span style="display:block;margin-top:4px;font-size:12px;font-weight:normal;color:{MUTED}">{" &middot; ".join(meta)}</span>'
            f'{tag}</td>'
            f'<td align="right" style="padding:14px 0 14px 12px;border-bottom:1px solid {LINE};font-family:{FONT};font-size:14px;'
            f'font-weight:bold;color:{INK};vertical-align:top;white-space:nowrap">{esc(str(line.get("amount", "")))}{was}</td></tr>'
        )
    if more:
        link = (f' &nbsp;<a href="{esc(more_url, quote=True)}" style="color:{COPPER};text-decoration:underline">See all</a>'
                if more_url else "")
        rows.append(f'<tr><td colspan="3" style="padding:12px 0;border-bottom:1px solid {LINE};font-family:{FONT};'
                    f'font-size:13px;color:{MUTED}">+ {more} more item{"s" if more != 1 else ""}{link}</td></tr>')
    money = []
    for row in summary:
        label, value = row[0], row[1]
        colour = SAGE if len(row) > 2 and row[2] == "saving" else INK_SOFT
        money.append(f'<tr><td style="padding:4px 0;font-family:{FONT};font-size:13px;color:{MUTED}">{esc(label)}</td>'
                     f'<td align="right" style="padding:4px 0;font-family:{FONT};font-size:13px;color:{colour};'
                     f'white-space:nowrap">{esc(str(value))}</td></tr>')
    if total:
        money.append(f'<tr><td style="padding:12px 0 0;{"border-top:1px solid " + LINE + ";" if summary else ""}'
                     f'font-family:{FONT};font-size:16px;font-weight:bold;color:{INK}">Total</td>'
                     f'<td align="right" style="padding:12px 0 0;{"border-top:1px solid " + LINE + ";" if summary else ""}'
                     f'font-family:{SERIF};font-size:20px;font-weight:bold;color:{INK};white-space:nowrap">{esc(total)}</td></tr>')
    footer = (f'<tr><td colspan="3" style="padding:12px 0 0">'
              f'{_table("".join(money), style="")}</td></tr>') if money else ""
    return (heading(title) if title else "") + _table(f'{"".join(rows)}{footer}', style="margin:8px 0 6px")


def note(text: str, *, raw: bool = False, tone: str = "brand", title: str = "") -> str:
    """A soft panel for something worth setting apart: a note from the team, a warning."""
    soft, accent, deep = _tone(tone)
    head = (f'<strong style="display:block;margin-bottom:4px;font-size:13px;color:{deep}">{esc(title)}</strong>'
            if title else "")
    return _table(
        f'<tr><td class="panel" style="padding:14px 18px;background:{soft};border-left:4px solid {accent};'
        f'border-radius:0 4px 4px 0;font-family:{FONT};font-size:14px;line-height:1.6;color:{INK_SOFT}">'
        f'{head}{text if raw else esc(text)}</td></tr>', style="margin:20px 0 6px")


def progress(steps: Sequence[str], current: int, *, tone: str = "brand") -> str:
    """
    Where something has got to: a bar per step, filled up to `current` (an
    index), with a tick for steps done. `current` of -1 shows none reached.
    """
    if not steps:
        return ""
    accent = _tone(tone)[1]
    width = 100 // len(steps)
    cells = []
    for i, label in enumerate(steps):
        done, here = i < current, i == current
        reached = done or here
        colour = accent if reached else LINE
        mark = "&#10003;" if done or (here and i == len(steps) - 1) else str(i + 1)
        cells.append(
            f'<td width="{width}%" align="center" valign="top" style="padding:0 2px">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
            f'<td height="4" style="height:4px;background:{colour};font-size:0;line-height:0">&nbsp;</td></tr></table>'
            f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:10px auto 6px;border-collapse:separate"><tr>'
            f'<td width="24" height="24" align="center" style="width:24px;height:24px;border-radius:12px;'
            f'background:{accent if reached else WHITE};border:2px solid {colour};font-family:{FONT};font-size:11px;'
            f'font-weight:bold;line-height:24px;color:{WHITE if reached else FAINT}">{mark}</td></tr></table>'
            f'<span class="step-label" style="display:block;font-family:{FONT};font-size:11px;line-height:1.3;'
            f'font-weight:{"bold" if here else "normal"};color:{INK if reached else FAINT}">{esc(label)}</span></td>'
        )
    return _table(f'<tr>{"".join(cells)}</tr>', style="margin:4px 0 22px")


def cards(entries: Sequence[Tuple[str, str]]) -> str:
    """
    Side-by-side panels (two to a row, one per row on a phone): each a
    (heading, trusted HTML) pair — the delivery address, the payment.
    """
    entries = [entry for entry in entries if entry and entry[1]]
    if not entries:
        return ""
    rows = []
    for start in range(0, len(entries), 2):
        pair = entries[start:start + 2]
        tds = []
        for i, (title, body) in enumerate(pair):
            gap = "padding:0 8px 0 0" if i == 0 and len(pair) == 2 else ("padding:0 0 0 8px" if i == 1 else "padding:0")
            panel = _table(
                f'<tr><td class="panel" style="padding:16px 18px;background:{CREAM_LIGHT};border:1px solid {LINE};'
                f'border-radius:4px;font-family:{FONT};font-size:14px;line-height:1.55;color:{INK_SOFT}">'
                f'<span style="display:block;margin-bottom:6px;font-size:11px;font-weight:bold;letter-spacing:.14em;'
                f'text-transform:uppercase;color:{COPPER}">{esc(title)}</span>{body}</td></tr>',
                style=f"border-collapse:separate")
            span = ' colspan="2"' if len(pair) == 1 and len(entries) > 1 else ""
            tds.append(f'<td class="stack stack-gap"{span} width="{50 if len(pair) == 2 else 100}%" valign="top" '
                       f'style="{gap}">{panel}</td>')
        rows.append(f'<tr>{"".join(tds)}</tr>')
    spacer = f'<tr><td colspan="2" height="14" style="height:14px;font-size:0;line-height:0">&nbsp;</td></tr>'
    return _table(spacer.join(rows), attrs=' class="cards"', style="margin:22px 0 6px;table-layout:fixed")


def address(name: str = "", lines: Sequence[str] = (), phone: str = "") -> str:
    """An address for a card: the name in bold, then each line."""
    parts = []
    if name:
        parts.append(f'<strong style="color:{INK}">{esc(name)}</strong>')
    parts.extend(esc(line) for line in lines if line)
    if phone:
        parts.append(f'<span style="color:{MUTED}">&#9742; {esc(phone)}</span>')
    return "<br>".join(parts)


def code_box(code: str, *, label: str = "", caption: str = "", tone: str = "brand") -> str:
    """A code to copy — a gift card, a one-time code, a coupon — big, spaced and dashed round."""
    soft, accent, deep = _tone(tone)
    top = (f'<span style="display:block;margin-bottom:8px;font-family:{FONT};font-size:11px;font-weight:bold;'
           f'letter-spacing:.16em;text-transform:uppercase;color:{deep}">{esc(label)}</span>') if label else ""
    bottom = (f'<span style="display:block;margin-top:8px;font-family:{FONT};font-size:12px;color:{MUTED}">'
              f'{esc(caption)}</span>') if caption else ""
    return _table(
        f'<tr><td align="center" class="panel" style="padding:20px 16px;background:{soft};border:2px dashed {accent};'
        f'border-radius:6px">{top}<span class="code" style="display:block;font-family:{MONO};font-size:26px;'
        f'font-weight:bold;letter-spacing:4px;line-height:1.3;color:{INK};word-break:break-all">{esc(code)}</span>{bottom}</td></tr>',
        style="margin:20px 0 8px")


def stats(entries: Sequence[tuple], *, tone: str = "brand") -> str:
    """Big numbers side by side — a balance, points, a saving: (label, value[, caption])."""
    entries = [e for e in entries if e and e[1] not in (None, "")]
    if not entries:
        return ""
    soft, accent, deep = _tone(tone)
    width = 100 // len(entries)
    cells = "".join(
        f'<td class="stack stack-gap" width="{width}%" align="center" valign="top" style="padding:0 {0 if i == len(entries) - 1 else 6}px 0 {0 if i == 0 else 6}px">'
        + _table(f'<tr><td align="center" class="panel" style="padding:16px 10px;background:{soft};border-radius:4px;border-top:3px solid {accent}">'
                 f'<span style="display:block;font-family:{FONT};font-size:11px;font-weight:bold;letter-spacing:.14em;text-transform:uppercase;color:{deep}">{esc(e[0])}</span>'
                 f'<span style="display:block;margin-top:6px;font-family:{SERIF};font-size:26px;line-height:1.2;color:{INK}">{esc(str(e[1]))}</span>'
                 + (f'<span style="display:block;margin-top:4px;font-family:{FONT};font-size:12px;color:{MUTED}">{esc(str(e[2]))}</span>' if len(e) > 2 and e[2] else "")
                 + "</td></tr>", style="")
        + "</td>"
        for i, e in enumerate(entries)
    )
    return _table(f"<tr>{cells}</tr>", style="margin:20px 0 6px")


def products(entries: Sequence[dict], *, title: str = "") -> str:
    """
    Product cards, two to a row (one on a phone): photo, name, price (with
    the old price struck through) and a link — each a dict of name, url,
    image, price, was, badge.
    """
    entries = list(entries)
    if not entries:
        return ""
    rows = []
    for start in range(0, len(entries), 2):
        pair = entries[start:start + 2]
        tds = []
        for i, entry in enumerate(pair):
            url = esc(entry.get("url") or "", quote=True)
            picture = (f'<a href="{url}" style="text-decoration:none"><img src="{esc(entry["image"], quote=True)}" width="252" '
                       f'alt="{esc(entry.get("name", ""), quote=True)}" class="product-img" style="display:block;width:100%;'
                       f'max-width:252px;height:auto;border:0;border-radius:4px 4px 0 0;background:{CREAM_DEEP}"></a>'
                       if _usable_image(entry.get("image")) else "")
            was = (f' <span style="font-size:13px;font-weight:normal;color:{FAINT};text-decoration:line-through">'
                   f'{esc(str(entry["was"]))}</span>') if entry.get("was") else ""
            tag = (f'<span style="display:block;margin-bottom:6px">{badge(entry["badge"], tone=entry.get("tone", "warning"))}</span>'
                   if entry.get("badge") else "")
            body = (f'<td class="panel" style="padding:14px 16px 16px;font-family:{FONT}">{tag}'
                    f'<a href="{url}" style="display:block;font-size:14px;line-height:1.4;font-weight:bold;color:{INK};text-decoration:none">{esc(entry.get("name", ""))}</a>'
                    + (f'<span style="display:block;margin-top:6px;font-size:16px;font-weight:bold;color:{CLAY}">{esc(str(entry["price"]))}{was}</span>' if entry.get("price") else "")
                    + (f'<span style="display:block;margin-top:4px;font-size:12px;color:{MUTED}">{esc(str(entry["detail"]))}</span>' if entry.get("detail") else "")
                    + (f'<a href="{url}" style="display:inline-block;margin-top:10px;font-size:12px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:{COPPER};text-decoration:none">{esc(entry.get("cta") or "View")} &rarr;</a>' if url else "")
                    + "</td>")
            card = _table((f"<tr><td>{picture}</td></tr>" if picture else "") + f"<tr>{body}</tr>",
                          style=f"background:{WHITE};border:1px solid {LINE};border-radius:4px;border-collapse:separate")
            pad = "padding:0 8px 0 0" if i == 0 and len(pair) == 2 else ("padding:0 0 0 8px" if i == 1 else "padding:0 25%")
            tds.append(f'<td class="stack stack-gap" width="50%" valign="top" style="{pad}">{card}</td>')
        if len(pair) == 1 and len(entries) > 1:
            tds = [tds[0].replace("padding:0 25%", "padding:0 8px 0 0"), '<td class="stack" width="50%">&nbsp;</td>']
        rows.append(f"<tr>{''.join(tds)}</tr>")
    spacer = f'<tr><td colspan="2" height="16" style="height:16px;font-size:0;line-height:0">&nbsp;</td></tr>'
    return (heading(title) if title else "") + _table(spacer.join(rows), style="margin:16px 0 6px")


def steps(entries: Sequence, *, title: str = "What happens next", tone: str = "brand") -> str:
    """A numbered list of what comes next: each a string, or a (bold, text) pair."""
    entries = [e for e in entries if e]
    if not entries:
        return ""
    accent = _tone(tone)[1]
    rows = []
    for i, entry in enumerate(entries, 1):
        text = (f'<strong style="color:{INK}">{esc(entry[0])}</strong><br>{esc(entry[1])}'
                if isinstance(entry, tuple) else esc(entry))
        rows.append(
            f'<tr><td width="34" valign="top" style="padding:10px 12px 10px 0">'
            f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr><td width="24" height="24" align="center" '
            f'style="width:24px;height:24px;border-radius:12px;background:{accent};font-family:{FONT};font-size:12px;'
            f'font-weight:bold;line-height:24px;color:{WHITE}">{i}</td></tr></table></td>'
            f'<td valign="top" style="padding:11px 0 10px;font-family:{FONT};font-size:14px;line-height:1.55;color:{INK_SOFT}">{text}</td></tr>')
    return (heading(title) if title else "") + _table("".join(rows), style="margin:6px 0 6px")


def quote(text: str, *, who: str = "", raw: bool = False) -> str:
    """Someone's words — a question, an answer, a reply from the team."""
    by = (f'<span style="display:block;margin-top:8px;font-family:{FONT};font-size:12px;font-style:normal;'
          f'font-weight:bold;letter-spacing:.06em;color:{COPPER}">&mdash; {esc(who)}</span>') if who else ""
    return _table(
        f'<tr><td class="panel" style="padding:16px 20px;background:{CREAM_LIGHT};border-left:4px solid {COPPER_PALE};'
        f'font-family:{SERIF};font-size:15px;font-style:italic;line-height:1.6;color:{INK}">'
        f'{text if raw else esc(text).replace(chr(10), "<br>")}{by}</td></tr>', style="margin:18px 0 6px")


def links(entries: Sequence[Tuple[str, str]]) -> str:
    """A centred row of small text links — the useful next places to go."""
    entries = [(label, url) for label, url in entries if url]
    if not entries:
        return ""
    joined = f' <span style="color:{LINE}">&nbsp;|&nbsp;</span> '.join(
        f'<a href="{esc(url, quote=True)}" style="color:{COPPER};text-decoration:underline;white-space:nowrap">{esc(label)}</a>'
        for label, url in entries)
    return (f'<p style="margin:16px 0 0;font-family:{FONT};font-size:13px;line-height:2;text-align:center;'
            f'color:{MUTED}">{joined}</p>')


def body_from(value) -> str:
    """
    Body HTML from whatever a caller passed: HTML as is, and a list of
    (label, value) pairs as a details box — never a Python list printed into
    the email.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        if all(isinstance(v, (list, tuple)) and len(v) == 2 for v in value):
            return details([(str(a), str(b)) for a, b in value])
        if all(isinstance(v, dict) for v in value):
            return items(value)
        return "".join(body_from(v) if not isinstance(v, str) else v for v in value)
    if isinstance(value, dict):
        return details([(str(k), str(v)) for k, v in value.items()])
    return esc(str(value))


# A few small pictures for the banner, by name. Emoji are coloured in every
# client that matters and need no image to load.
ICONS = {
    "bag": "&#128717;&#65039;", "check": "&#9989;", "box": "&#128230;", "truck": "&#128666;", "home": "&#127968;",
    "pin": "&#128205;", "card": "&#128179;", "warning": "&#9888;&#65039;", "cross": "&#10060;", "return": "&#8617;&#65039;",
    "refund": "&#128176;", "receipt": "&#129534;", "gift": "&#127873;", "star": "&#11088;", "crown": "&#128081;",
    "heart": "&#10084;&#65039;", "bell": "&#128276;", "lock": "&#128274;", "key": "&#128273;", "shield": "&#128737;&#65039;",
    "mail": "&#9993;&#65039;", "chat": "&#128172;", "question": "&#10067;", "fire": "&#128293;", "tag": "&#127991;&#65039;",
    "sparkles": "&#10024;", "wave": "&#128075;", "wallet": "&#128091;", "people": "&#128101;", "clock": "&#9200;",
    "phone": "&#128241;", "link": "&#128279;", "chart": "&#128200;", "gear": "&#9881;&#65039;",
}


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
    tone: str = "brand",
    icon: str = "",
    eyebrow: str = "",
    banner_html: str = "",
    secondary: Sequence[Tuple[str, str]] = (),
) -> str:
    """
    The whole email. `intro_html`, `body_html` and `banner_html` are trusted
    HTML built by the server (with every customer value escaped); everything
    else is escaped here. The unsubscribe link appears only on marketing email.

    The banner at the top is coloured by `tone` and carries an `icon` (a name
    from `ICONS`), a small `eyebrow` label, the title, the intro and
    `banner_html` (an order number, a status). `secondary` is a row of text
    links under the button.
    """
    b = brand()
    url = b["url"]
    home = esc(url, quote=True)
    name = esc(b["name"])
    pre = esc(preheader or "")
    soft, accent, deep = _tone(tone)
    body_html = body_from(body_html)
    intro = (f'<p class="intro" style="margin:0 auto;max-width:460px;font-family:{FONT};font-size:15px;line-height:1.65;color:{INK_SOFT}">{intro_html}</p>'
             if intro_html and not intro_html.lstrip().startswith(("<p", "<table", "<h2", "<ul", "<ol")) else intro_html)
    symbol = ICONS.get(icon, "")
    icon_html = (f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 14px;border-collapse:separate"><tr>'
                 f'<td width="60" height="60" align="center" valign="middle" style="width:60px;height:60px;border-radius:30px;'
                 f'background:{WHITE};border:2px solid {accent};font-size:26px;line-height:60px">{symbol}</td></tr></table>'
                 ) if symbol else ""
    eyebrow_html = (f'<p style="margin:0 0 8px;font-family:{FONT};font-size:11px;font-weight:bold;letter-spacing:.2em;'
                    f'text-transform:uppercase;color:{deep}">{esc(eyebrow)}</p>') if eyebrow else ""

    contact_bits = []
    if b.get("supportEmail"):
        contact_bits.append(f'<a href="mailto:{esc(b["supportEmail"], quote=True)}" style="color:{COPPER};text-decoration:underline">{esc(b["supportEmail"])}</a>')
    if b.get("supportPhone"):
        contact_bits.append(f'<a href="tel:{esc(re.sub(r"[^0-9+]", "", b["supportPhone"]), quote=True)}" style="color:{COPPER};text-decoration:underline">{esc(b["supportPhone"])}</a>')
    hours = f'<br><span style="color:{FAINT}">{esc(b["supportHours"])}</span>' if b.get("supportHours") else ""
    help_line = (f'Questions? We\'re here to help &mdash; {" &middot; ".join(contact_bits)}{hours}<br>'
                 f'or <a href="{home}/faq" style="color:{COPPER};text-decoration:underline">visit our help centre</a>.'
                 if contact_bits else
                 f'Questions? We\'re here to help &mdash; '
                 f'<a href="{home}/faq" style="color:{COPPER};text-decoration:underline">visit our help centre</a>.{hours}')

    link_style = "color:#ddd6ce;text-decoration:none"
    policies = " &nbsp;&middot;&nbsp; ".join(
        f'<a href="{home}{path}" style="{link_style}">{label}</a>'
        for label, path in (("Shop", "/"), ("My account", "/account"), ("Shipping", "/shipping"), ("Returns", "/returns"),
                            ("Privacy", "/privacy"), ("Terms", "/terms"))
    )
    social = (" &nbsp;&middot;&nbsp; ".join(f'<a href="{esc(link, quote=True)}" style="color:{COPPER_PALE};text-decoration:none;font-weight:bold">{esc(label)}</a>'
                                            for label, link in b.get("social", []))) if b.get("social") else ""
    why = esc(footnote) if footnote else (
        "You're receiving this marketing email because you chose to hear about offers from us." if marketing else
        "You're receiving this because of activity on your account with us.")
    small = f"margin:10px 0 0;font-family:{FONT};font-size:12px;line-height:1.6;color:#b5ada5"
    footer_links = ""
    if marketing and unsubscribe_url:
        footer_links = (f'<p style="{small}"><a href="{esc(unsubscribe_url, quote=True)}" style="color:#ddd6ce;text-decoration:underline">Unsubscribe</a>'
                        + (f' &nbsp;&middot;&nbsp; <a href="{esc(preferences_url, quote=True)}" style="color:#ddd6ce;text-decoration:underline">Email preferences</a>' if preferences_url else "")
                        + "</p>")
    elif preferences_url:
        footer_links = (f'<p style="{small}"><a href="{esc(preferences_url, quote=True)}" style="color:#ddd6ce;text-decoration:underline">Email preferences</a></p>')
    pixel = (f'<img src="{esc(tracking_pixel, quote=True)}" width="1" height="1" alt="" '
             f'style="display:block;width:1px;height:1px;border:0;opacity:0">') if tracking_pixel else ""
    button_html = button(*cta) if cta else ""
    more_links = links(secondary)
    logo = esc(b["logo"], quote=True)
    tagline = (f'<span class="hide-mobile" style="display:block;font-family:{FONT};font-size:10px;letter-spacing:.18em;'
               f'text-transform:uppercase;color:{COPPER};margin-top:3px">{esc(b["tagline"])}</span>') if b.get("tagline") else ""

    return f"""<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
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
    .outer {{ padding:0 !important; }}
    .container {{ width:100% !important; max-width:100% !important; }}
    .card {{ border-radius:0 !important; }}
    .pad {{ padding-left:20px !important; padding-right:20px !important; }}
    .hero {{ padding-top:28px !important; padding-bottom:26px !important; }}
    .title {{ font-size:23px !important; line-height:1.3 !important; }}
    .stack {{ display:block !important; width:100% !important; max-width:100% !important; text-align:left !important; box-sizing:border-box; }}
    .stack-tight {{ padding-top:0 !important; }}
    .stack-gap {{ padding:0 0 14px 0 !important; }}
    .cards {{ table-layout:auto !important; }}
    .cards, .cards > tbody, .cards > tbody > tr, .cards > tr {{ display:block !important; width:100% !important; }}
    .cards td.stack {{ display:block !important; width:100% !important; }}
    .stack > table {{ width:100% !important; }}
    .button-wrap {{ width:100% !important; }}
    .button {{ display:block !important; text-align:center !important; padding-left:12px !important; padding-right:12px !important; }}
    .product-img {{ max-width:100% !important; }}
    .step-label {{ font-size:10px !important; }}
    .code {{ font-size:21px !important; letter-spacing:2px !important; }}
    .hide-mobile {{ display:none !important; }}
  }}
  :root {{ color-scheme: light only; supported-color-schemes: light; }}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:{CREAM_DEEP};word-spacing:normal">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:{CREAM_DEEP}">{pre}&#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847;</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{CREAM_DEEP}">
<tr><td align="center" class="outer" style="padding:28px 12px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto">
  <tr><td class="card" style="background:{WHITE};border-radius:6px;overflow:hidden;box-shadow:0 4px 16px -4px rgba(30,27,24,.10)">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td height="4" style="height:4px;background:{COPPER_BRIGHT};font-size:0;line-height:0;border-radius:6px 6px 0 0">&nbsp;</td></tr>
      <tr><td class="pad head" style="padding:20px 36px;background:{WHITE};border-bottom:1px solid {LINE}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="vertical-align:middle;padding-right:12px"><a href="{home}" style="text-decoration:none"><img src="{logo}" width="44" height="44" alt="{name}" style="display:block;width:44px;height:44px;border-radius:22px;border:0;font-family:{FONT};font-size:12px;color:{INK}"></a></td>
              <td style="vertical-align:middle"><a href="{home}" style="text-decoration:none;font-family:{SERIF};font-size:19px;line-height:1.2;color:{INK}">{name}</a>{tagline}</td>
            </tr></table>
          </td>
          <td align="right" style="vertical-align:middle;font-family:{FONT};font-size:12px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap"><a href="{home}/account" style="color:{COPPER};text-decoration:none">My account</a></td>
        </tr></table>
      </td></tr>
      <tr><td class="pad hero" align="center" style="padding:36px 40px 32px;background:{soft};text-align:center;border-bottom:1px solid {LINE}">
        {icon_html}{eyebrow_html}
        <h1 class="title" style="margin:0 0 12px;font-family:{SERIF};font-weight:normal;font-size:28px;line-height:1.25;color:{INK}">{esc(title)}</h1>
        {intro}
        {banner_html}
      </td></tr>
      <tr><td class="pad" style="padding:30px 40px 34px">
        {body_html}
        {button_html}
        {more_links}
      </td></tr>
      <tr><td class="pad help" style="padding:20px 40px;background:{CREAM_LIGHT};border-top:1px solid {LINE};font-family:{FONT};font-size:13px;line-height:1.7;color:{INK_SOFT};text-align:center;border-radius:0 0 6px 6px">
        {help_line}
      </td></tr>
    </table>
  </td></tr>
  <tr><td class="pad" style="padding:28px 40px 30px;text-align:center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{INK};border-radius:6px"><tr><td style="padding:26px 22px;text-align:center">
      <a href="{home}" style="text-decoration:none"><img src="{logo}" width="40" height="40" alt="" style="display:inline-block;width:40px;height:40px;border-radius:20px;border:0;background:{CREAM_LIGHT}"></a>
      <p style="margin:8px 0 0;font-family:{SERIF};font-size:17px;color:{CREAM_LIGHT}"><a href="{home}" style="color:{CREAM_LIGHT};text-decoration:none">{name}</a></p>
      {f'<p style="margin:4px 0 0;font-family:{FONT};font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:{COPPER_PALE}">{esc(b["tagline"])}</p>' if b.get("tagline") else ""}
      <p style="margin:14px 0 0;font-family:{FONT};font-size:12px;line-height:2;color:#ddd6ce">{policies}</p>
      {f'<p style="margin:6px 0 0;font-family:{FONT};font-size:12px;line-height:1.8">{social}</p>' if social else ""}
      <p style="{small};margin-top:14px">{why}</p>
      {footer_links}
      {pixel}
    </td></tr></table>
  </td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>"""
