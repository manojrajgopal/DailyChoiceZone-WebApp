/**
 * Make every image inside `root` part of the page before it is printed or
 * turned into a PDF.
 *
 * The invoice is copied into a hidden or off-screen container for both. Phone
 * browsers do not fetch lazily-loaded images there before printing — which is
 * why the logo came out as an empty circle on phones while desktops showed
 * it. Each image is fetched once and embedded as a data URL, then awaited, so
 * nothing depends on the browser's loading rules. An image that cannot be
 * fetched keeps its original address; the document still prints.
 */
export async function inlineImages(root: HTMLElement, timeoutMs = 4000): Promise<void> {
  const images = Array.from(root.querySelectorAll("img"));

  const work = images.map(async (img) => {
    img.loading = "eager";
    img.decoding = "sync";
    const source = img.currentSrc || img.getAttribute("src") || "";
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    if (!source || source.startsWith("data:")) return;

    try {
      const response = await fetch(source, { cache: "force-cache" });
      if (!response.ok) throw new Error(String(response.status));
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      img.src = dataUrl;
    } catch {
      img.src = source;
    }

    if (!img.complete) {
      await new Promise<void>((resolve) => {
        img.addEventListener("load", () => resolve(), { once: true });
        img.addEventListener("error", () => resolve(), { once: true });
      });
    }
  });

  await Promise.race([
    Promise.all(work),
    new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs)),
  ]);
}
