/**
 * The invoice as a PDF — the same document the print view produces.
 *
 * The invoice on screen is cloned into an off-screen A4-width frame and given
 * the `pdf-capture` class, which switches on the same `doc:` layout rules the
 * print stylesheet uses (see `globals.css`). The browser itself renders that
 * clone to an image (`html-to-image` draws it through SVG, so every colour,
 * font and border comes out exactly as it does on screen), and the image is
 * laid onto A4 pages with a 14 mm margin.
 *
 * Page breaks fall *between* table rows and sections, never through one: the
 * bottom edge of every row is a candidate break, and each page ends at the
 * last candidate that fits.
 *
 * Both libraries are loaded only when somebody asks for a PDF.
 */

import { inlineImages } from "@/lib/billing/inlineImages";

/** A4 at 96 CSS px per inch. */
const PAGE_W = 794;
const PAGE_H = 1123;
/** 14 mm, the print stylesheet's margin. */
const MARGIN = 53;
const CONTENT_W = PAGE_W - MARGIN * 2;
const CONTENT_H = PAGE_H - MARGIN * 2;
const SCALE = 2;

export async function downloadInvoicePdf(source: HTMLElement, filename: string): Promise<void> {
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import("html-to-image"), import("jspdf")]);

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${CONTENT_W}px;background:#fff;`;

  const clone = source.cloneNode(true) as HTMLElement;
  clone.classList.add("pdf-capture");
  clone.querySelectorAll(".print-hidden").forEach((node) => node.remove());
  host.appendChild(clone);
  document.body.appendChild(host);

  try {
    await document.fonts?.ready;
    // Embedded and loaded, so the logo appears on phones too.
    await inlineImages(clone);

    // Where a page may end: under any row, section, header or footer.
    const top = clone.getBoundingClientRect().top;
    const height = clone.scrollHeight;
    const breaks = Array.from(clone.querySelectorAll("tr, section, header, footer, dl > div"))
      .map((node) => Math.round(node.getBoundingClientRect().bottom - top))
      .filter((y) => y > 0 && y <= height)
      .sort((a, b) => a - b);

    const canvas = await toCanvas(clone, {
      pixelRatio: SCALE,
      backgroundColor: "#ffffff",
      width: CONTENT_W,
      height,
    });

    const pdf = new jsPDF({
      unit: "px",
      format: [PAGE_W, PAGE_H],
      hotfixes: ["px_scaling"],
      compress: true,
    });

    let start = 0;
    let first = true;
    while (start < height - 1) {
      const limit = start + CONTENT_H;
      const fits = breaks.filter((y) => y > start && y <= limit);
      const end = limit >= height ? height : (fits[fits.length - 1] ?? limit);

      const slice = document.createElement("canvas");
      slice.width = CONTENT_W * SCALE;
      slice.height = Math.ceil((end - start) * SCALE);
      const context = slice.getContext("2d");
      if (!context) throw new Error("This browser cannot draw the PDF.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, slice.width, slice.height);
      context.drawImage(canvas, 0, -start * SCALE);

      if (!first) pdf.addPage([PAGE_W, PAGE_H]);
      // JPEG, not PNG: a lossless 2x page is ~2.5 MB; this is ~150 KB and
      // still sharp at print resolution.
      pdf.addImage(
        slice.toDataURL("image/jpeg", 0.92),
        "JPEG",
        MARGIN,
        MARGIN,
        CONTENT_W,
        end - start,
        undefined,
        "FAST",
      );
      first = false;
      start = end;
    }

    pdf.save(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
  } finally {
    document.body.removeChild(host);
  }
}
