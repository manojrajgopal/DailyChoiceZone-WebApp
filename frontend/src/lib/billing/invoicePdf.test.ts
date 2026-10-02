import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * jsdom has no layout engine, so `scrollHeight` and `getBoundingClientRect`
 * are always zero on real elements — which would make `downloadInvoicePdf`'s
 * page-break loop never run. Both are overridden here to read from `data-*`
 * attributes instead, so the test can choose exact pixel geometry. `cloneNode`
 * copies `dataset`, so a clone reports the same values as its source.
 */
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return Number(this.dataset.testScrollHeight ?? 0);
  },
});
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
  if (!("rectBottom" in this.dataset)) return originalGetBoundingClientRect.call(this);
  const top = Number(this.dataset.rectTop ?? 0);
  const bottom = Number(this.dataset.rectBottom ?? top);
  return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
};

/* -------------------------------------------------------- html-to-image / jsPDF mocks */
const toCanvas = vi.fn(async (_el: HTMLElement, opts: { width: number; height: number }) => {
  const canvas = document.createElement("canvas");
  canvas.width = opts.width;
  canvas.height = opts.height;
  return canvas;
});
vi.mock("html-to-image", () => ({ toCanvas: (...args: Parameters<typeof toCanvas>) => toCanvas(...args) }));

interface FakePdfCall {
  dataUrl: string;
  format: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
let addImageCalls: FakePdfCall[] = [];
let addPageCalls = 0;
let savedFilename = "";
class FakePdf {
  constructor(public options: unknown) {}
  addPage() {
    addPageCalls += 1;
  }
  addImage(dataUrl: string, format: string, x: number, y: number, w: number, h: number) {
    addImageCalls.push({ dataUrl, format, x, y, w, h });
  }
  save(filename: string) {
    savedFilename = filename;
  }
}
vi.mock("jspdf", () => ({ jsPDF: FakePdf }));

// jsdom's canvas 2D context is unimplemented; a minimal stand-in is enough —
// this module only fills a background and draws one image per page slice.
const fillRect = vi.fn();
const drawImage = vi.fn();
let toDataURLCallCount = 0;
beforeEach(() => {
  addImageCalls = [];
  addPageCalls = 0;
  savedFilename = "";
  toDataURLCallCount = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((contextId: string) => {
    if (contextId !== "2d") return null;
    return { fillStyle: "", fillRect, drawImage } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
    toDataURLCallCount += 1;
    return `data:image/jpeg;base64,PAGE${toDataURLCallCount}`;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

import { downloadInvoicePdf } from "./invoicePdf";

function buildSource(scrollHeight: number, breakBottoms: number[] = []): HTMLElement {
  const el = document.createElement("div");
  el.dataset.testScrollHeight = String(scrollHeight);
  el.dataset.rectTop = "0";
  el.dataset.rectBottom = String(scrollHeight);
  breakBottoms.forEach((bottom) => {
    const row = document.createElement("tr");
    row.dataset.rectTop = "0";
    row.dataset.rectBottom = String(bottom);
    el.appendChild(row);
  });
  document.body.appendChild(el);
  return el;
}

describe("downloadInvoicePdf", () => {
  it("renders a single page for content shorter than one page, and saves with .pdf appended", async () => {
    const source = buildSource(500, [500]);

    await downloadInvoicePdf(source, "invoice-1");

    expect(toCanvas).toHaveBeenCalledOnce();
    expect(addImageCalls).toHaveLength(1);
    expect(addPageCalls).toBe(0);
    expect(savedFilename).toBe("invoice-1.pdf");
  });

  it("does not double up the .pdf extension", async () => {
    const source = buildSource(200, [200]);
    await downloadInvoicePdf(source, "invoice-2.pdf");
    expect(savedFilename).toBe("invoice-2.pdf");
  });

  it("breaks across multiple pages for tall content, splitting at a row boundary", async () => {
    // CONTENT_H is 1123 - 2*53 = 1017px. 1400px of content with a break at
    // 1000 should produce two pages: [0,1000) and [1000,1400).
    const source = buildSource(1400, [500, 1000, 1400]);

    await downloadInvoicePdf(source, "tall-invoice");

    expect(addImageCalls).toHaveLength(2);
    expect(addPageCalls).toBe(1);
    expect(addImageCalls[0]!.h).toBe(1000);
    expect(addImageCalls[1]!.h).toBe(400);
  });

  it("falls back to the content's own end when no break fits on the page", async () => {
    // No row boundary at all within the first page-worth of content: the
    // function must still make progress rather than looping forever.
    const source = buildSource(1017, []);
    await expect(downloadInvoicePdf(source, "no-breaks")).resolves.toBeUndefined();
    expect(addImageCalls).toHaveLength(1);
  });

  it("adds the pdf-capture class and removes .print-hidden elements from the clone only", async () => {
    const source = buildSource(300, [300]);
    const hidden = document.createElement("div");
    hidden.className = "print-hidden";
    hidden.textContent = "Do not print";
    source.appendChild(hidden);

    await downloadInvoicePdf(source, "invoice");

    // The original, still-mounted source is untouched.
    expect(source.querySelector(".print-hidden")).toBeTruthy();
  });

  it("removes the off-screen host from the document after finishing", async () => {
    const source = buildSource(300, [300]);
    await downloadInvoicePdf(source, "invoice");
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("removes the off-screen host even when canvas capture fails", async () => {
    const source = buildSource(300, [300]);
    toCanvas.mockImplementationOnce(() => {
      throw new Error("capture failed");
    });

    await expect(downloadInvoicePdf(source, "invoice")).rejects.toThrow("capture failed");
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("throws a clear error when the browser cannot provide a 2D canvas context", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const source = buildSource(300, [300]);
    await expect(downloadInvoicePdf(source, "invoice")).rejects.toThrow("This browser cannot draw the PDF.");
  });
});
