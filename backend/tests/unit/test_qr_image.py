"""
Cutting the QR code out of Razorpay's poster.

The bug this guards against is specific and silent: the poster is a portrait
image with the scannable code a third of the way down it, and rendering the
whole thing in a square payment panel shrinks the code's modules below what a
camera can resolve. The page still shows *an image*, so nothing looks broken —
it simply cannot be scanned.

A poster is synthesised here rather than fetched, so the test does not depend
on Razorpay's uptime or on their template staying byte-identical. What it
asserts is the property that matters: whatever comes out is square, is the code
and not the furniture around it, and survives being displayed small.
"""

from __future__ import annotations

import io

import pytest

# No marker: `pytest.ini` registers only `integration`, and this touches
# neither the API nor the database.
pytest.importorskip("PIL", reason="Pillow does the cropping")

from PIL import Image  # noqa: E402

from app.services.payments import qr_image  # noqa: E402


# The poster's proportions, taken from a real one: 674 × 1644, with a 378-wide
# code at x 146 and y 656.
POSTER = (674, 1644)
CODE_BOX = (146, 656, 524, 1034)


def build_poster(*, with_code: bool = True) -> bytes:
    """
    A stand-in for Razorpay's poster.

    Deliberately includes the two things that fooled earlier attempts at this:
    a saturated blue band that is dark enough to pass a brightness test and
    spans the full width, and a strip of dark grey logos directly above the
    code that is wide but not square.
    """
    image = Image.new("RGBA", POSTER, (255, 255, 255, 255))
    pixels = image.load()

    # The blue diagonal artwork, full width.
    for y in range(430, 1180):
        for x in range(POSTER[0]):
            if (x + y) % 700 < 260:
                pixels[x, y] = (11, 95, 255, 255)

    # The logo strip: wide, short, dark grey.
    for y in range(566, 614):
        for x in range(150, 520):
            if (x // 7) % 2 == 0:
                pixels[x, y] = (60, 60, 65, 255)

    if with_code:
        left, top, right, bottom = CODE_BOX
        # A chequer dense enough to read as a code, plus solid finder squares.
        for y in range(top, bottom):
            for x in range(left, right):
                if ((x - left) // 9 + (y - top) // 9) % 2 == 0:
                    pixels[x, y] = (0, 0, 0, 255)

        for corner_x, corner_y in ((left, top), (right - 63, top), (left, bottom - 63)):
            for y in range(corner_y, corner_y + 63):
                for x in range(corner_x, corner_x + 63):
                    pixels[x, y] = (0, 0, 0, 255)

    # The caption below: one dark line, wide and short.
    for y in range(1080, 1104):
        for x in range(160, 510):
            if (x // 5) % 2 == 0:
                pixels[x, y] = (26, 26, 46, 255)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def size_of(data: bytes) -> tuple:
    return Image.open(io.BytesIO(data)).size


class TestExtraction:
    def test_it_returns_a_square(self):
        """
        The code is square; the poster is not.

        A non-square result is the visible half of the bug — the code arrives
        stretched as well as small.
        """
        width, height = size_of(qr_image.extract(build_poster()))
        assert abs(width - height) <= 2, (width, height)

    def test_it_is_the_code_and_not_the_poster(self):
        """
        Roughly the code plus its quiet zone, and nothing like the poster.

        The poster is 1644 tall; anything close to that means the furniture
        came along.
        """
        width, height = size_of(qr_image.extract(build_poster()))
        code_side = CODE_BOX[2] - CODE_BOX[0]

        assert code_side <= width <= code_side * 1.3, width
        assert height < POSTER[1] / 2

    def test_the_code_fills_the_result(self):
        """
        The whole point: the modules have to be big relative to the image.

        In the poster the code is about 23% of the height, so displaying the
        poster at 240px left the modules a fifth of their real size. Here it
        must be most of the image.
        """
        data = qr_image.extract(build_poster())
        image = Image.open(io.BytesIO(data)).convert("L")
        width, height = image.size
        pixels = image.load()

        dark = sum(
            1
            for y in range(0, height, 3)
            for x in range(0, width, 3)
            if pixels[x, y] < 128
        )
        sampled = len(range(0, height, 3)) * len(range(0, width, 3))

        # A chequer with three finder squares lands comfortably in this band;
        # a mostly-white poster crop would fall well below it.
        assert 0.25 < dark / sampled < 0.75, dark / sampled

    def test_it_keeps_a_quiet_zone(self):
        """
        A code with no margin is a code many apps refuse.

        The outermost ring of the result must be white.
        """
        data = qr_image.extract(build_poster())
        image = Image.open(io.BytesIO(data)).convert("L")
        width, height = image.size
        pixels = image.load()

        edges = (
            [pixels[x, 0] for x in range(width)]
            + [pixels[x, height - 1] for x in range(width)]
            + [pixels[0, y] for y in range(height)]
            + [pixels[width - 1, y] for y in range(height)]
        )
        assert all(value > 200 for value in edges)

    def test_it_is_far_smaller_than_the_poster(self):
        """
        A bitonal crop instead of a 396 KB photograph.

        Not cosmetic: it is fetched on a payment screen somebody is waiting on.
        """
        poster = build_poster()
        assert len(qr_image.extract(poster)) < len(poster) / 4

    def test_a_poster_with_no_code_comes_back_whole(self):
        """
        Better a poster than nothing.

        If the template changes beyond recognition the page should still show
        whatever the gateway sent, rather than a broken image.
        """
        poster = build_poster(with_code=False)
        assert qr_image.extract(poster) == poster

    def test_rubbish_comes_back_untouched(self):
        assert qr_image.extract(b"not an image") == b"not an image"


class TestFetching:
    def test_an_unreachable_poster_is_none_not_an_exception(self, monkeypatch):
        """
        The route turns `None` into a clean 404.

        A payment page is the worst place for a stack trace.
        """
        import httpx

        def refuse(*_args, **_kwargs):
            raise httpx.ConnectError("nope")

        monkeypatch.setattr(httpx, "get", refuse)
        assert qr_image.fetch("https://example.invalid/qr.png") is None
