"""
Cutting the QR out of Razorpay's poster.

## Why this exists

Razorpay's QR Codes API returns one image: a 674×1644 portrait **poster**. The
scannable code is a 378×378 square roughly a third of the way down it, and the
rest is a "Powered by Razorpay" banner, BHIM and UPI marks, GPay/PhonePe/Paytm
logos, the merchant's name and a caption. There is no bare-QR variant — every
documented and undocumented query parameter returns the same PNG.

Rendering that poster in a square box on a payment page shrinks the code to
roughly a fifth of its real size and squashes it out of square. A QR at that
scale has modules smaller than a camera can resolve, so **no UPI app can read
it** — which is exactly the failure this fixes.

So the poster is fetched once, the code is located inside it, and only the code
is served.

## Why the code is located rather than hard-coded

A fixed crop rectangle is a guess about someone else's template, and it breaks
silently the day they change it — silently being the problem, because the
result is still an image, just not a scannable one. This measures instead:

1. Flatten onto white. The poster has an alpha channel, and treating
   transparent pixels as dark makes every row look full of them.
2. Find **near-black, unsaturated** pixels. Not merely "dark" — the artwork is
   a saturated blue whose luminance is low enough to pass a brightness test,
   and it spans the full width, which drowns the signal.
3. Take the dense column span. That is the code's width, and it is clean: the
   code is the widest black thing on the poster.
4. Find the dense row runs, and keep the one whose height matches that width.
   A QR is square, which is what separates it from the logo strip above it and
   the caption below.

If any step finds nothing recognisable the poster is returned untouched, since
a whole poster is worse than a bare code but far better than no image at all.
"""

from __future__ import annotations

import io
import logging
from typing import Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

# A module is near-black and close to grey. The poster's artwork is a saturated
# blue that is dark enough to pass a brightness test on its own.
MAX_CHANNEL = 100
MAX_SPREAD = 40

# A row counts as part of a solid block at this fraction of the densest row.
DENSITY = 0.4

# Rows this far apart still belong to one block — a QR has white bands inside
# it, and the quiet zone between finder patterns is wider than a few pixels.
MAX_GAP = 28

# How far the located block's height may differ from its width and still be
# accepted as the square code.
SQUARE_TOLERANCE = 0.25

# Breathing room added around the crop. A QR needs a quiet zone to be read;
# without one, apps that expect the margin fail on an otherwise perfect code.
QUIET_ZONE = 0.08


def fetch(image_url: str) -> Optional[bytes]:
    """The poster, as Razorpay serves it."""
    try:
        response = httpx.get(image_url, follow_redirects=True, timeout=20.0)
        response.raise_for_status()
        return response.content
    except httpx.HTTPError as error:
        logger.error("QR poster could not be fetched: %s", error)
        return None


def extract(poster: bytes) -> bytes:
    """
    The QR code alone, with a quiet zone, on white.

    Returns the poster unchanged if the code cannot be located — see the module
    docstring for why that is the right failure.
    """
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover - Pillow is a declared dependency
        logger.error("Pillow is not installed; serving the poster as-is.")
        return poster

    try:
        original = Image.open(io.BytesIO(poster)).convert("RGBA")
    except Exception as error:  # noqa: BLE001 - any decode failure is the same
        logger.error("QR poster could not be decoded: %s", error)
        return poster

    # Onto white first: the poster is transparent in places, and a transparent
    # pixel read as black makes every row look solid.
    flat = Image.alpha_composite(
        Image.new("RGBA", original.size, (255, 255, 255, 255)), original
    ).convert("RGB")

    box = _locate(flat)
    if box is None:
        logger.warning("QR code could not be located in the poster; serving it whole.")
        return poster

    left, top, right, bottom = box

    # Exactly the code, then flattened to plain black and white. The poster is
    # a rendering of a code — faintly off-white, slightly grey modules — and a
    # camera reads a bitonal image more reliably than a nearly-clean one.
    code = (
        flat.crop((left, top, right, bottom))
        .convert("L")
        .point(lambda value: 0 if value < 128 else 255, mode="1")
    )

    # The quiet zone is *added*, not cropped in. Taking a margin from the
    # poster means taking whatever the poster has there — and behind the code
    # is a blue diagonal, so the margin would arrive part dark. A code whose
    # quiet zone is not quiet is a code many apps decline to read.
    margin = max(8, int(code.width * QUIET_ZONE))
    crop = Image.new("1", (code.width + margin * 2, code.height + margin * 2), 1)
    crop.paste(code, (margin, margin))

    buffer = io.BytesIO()
    crop.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def _locate(image) -> Optional[Tuple[int, int, int, int]]:
    """The code's bounding box, measured rather than assumed."""
    width, height = image.size
    pixels = image.load()

    # Sampled every other pixel. The code's modules are several pixels across,
    # so this halves the work in each direction and changes no outcome.
    step = 2

    def is_module(x: int, y: int) -> bool:
        red, green, blue = pixels[x, y]
        channel = max(red, green, blue)
        return channel < MAX_CHANNEL and channel - min(red, green, blue) < MAX_SPREAD

    columns = [
        sum(1 for y in range(0, height, step) if is_module(x, y))
        for x in range(0, width, step)
    ]
    if not any(columns):
        return None

    column_span = _densest_run(columns, step)
    if column_span is None:
        return None

    left, right = column_span
    side = right - left
    if side < 40:
        return None

    # Rows are counted only inside those columns, so the logo strip and the
    # caption — both narrower and sparser — cannot pull the block around.
    rows = [
        sum(1 for x in range(left, right, step) if is_module(x, y))
        for y in range(0, height, step)
    ]

    runs = _runs(rows, step)
    if not runs:
        return None

    # The square one. A QR is square; the logo strip above is wide and short,
    # and the caption below is a single line.
    #
    # If nothing is square then nothing here is a QR code, and saying so is
    # the point — falling back to "the tallest block" would crop the logo
    # strip and serve it as though it were scannable.
    square = [
        run for run in runs if abs((run[1] - run[0]) - side) <= side * SQUARE_TOLERANCE
    ]
    if not square:
        return None

    top, bottom = max(square, key=lambda run: run[1] - run[0])

    return left, top, right, bottom


def _runs(counts: list, step: int) -> list:
    """Contiguous stretches of dense lines, in pixel coordinates."""
    peak = max(counts)
    if peak == 0:
        return []

    threshold = peak * DENSITY
    found = []
    start = None
    gap = 0

    for index, count in enumerate(counts):
        if count >= threshold:
            if start is None:
                start = index
            gap = 0
        elif start is not None:
            gap += step
            if gap > MAX_GAP:
                found.append((start * step, (index * step) - gap))
                start = None

    if start is not None:
        found.append((start * step, len(counts) * step))

    return [run for run in found if run[1] > run[0]]


def _densest_run(counts: list, step: int) -> Optional[Tuple[int, int]]:
    """The longest dense stretch — for columns, the code's width."""
    runs = _runs(counts, step)
    if not runs:
        return None
    return max(runs, key=lambda run: run[1] - run[0])
