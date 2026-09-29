/**
 * Where to send someone after they sign in — if it is safe to.
 *
 * The sign-in page accepts `?next=` so a shopper sent there from the middle of
 * checkout lands back on the step they left. Taken unchecked, that parameter is
 * an **open redirect**: a link to this site's sign-in page with
 * `next=https://evil.example` would bounce a freshly signed-in customer to a
 * page that looks like the next step and asks for their card.
 *
 * So only a path on this site is accepted. Each rule below closes a trick that
 * the obvious check (`startsWith("/")`) lets through:
 *
 * - `//evil.example` is protocol-relative — a different host, not a path.
 * - `/\evil.example` is read as `//evil.example` by some browsers.
 * - control characters, including a tab or newline inside `/\t/evil`, are
 *   stripped by URL parsers and can reassemble into the forms above.
 * - `javascript:` and every other scheme simply fail the leading-slash rule.
 *
 * Anything that fails falls back to `fallback`, never to the raw value.
 */
export function safeRedirect(target: string | null | undefined, fallback = "/account"): string {
  if (!target) return fallback;

  let value: string;
  try {
    // Once, not repeatedly: decoding until stable would let `%252F` become
    // `/` after the check below has already passed it.
    value = decodeURIComponent(target);
  } catch {
    return fallback;
  }

  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;

  // Resolved against a throwaway origin: if the result is anywhere else, the
  // "path" was really a host.
  try {
    const resolved = new URL(value, "https://same-site.invalid");
    if (resolved.origin !== "https://same-site.invalid") return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}
