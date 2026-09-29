/**
 * Uploaded product photographs, served from the storefront's own origin.
 *
 * `GET /media/products/<name>.webp` fetches `/uploads/products/<name>.webp`
 * from the API and passes it on. Only that one shape of path is accepted — a
 * folder, a random file name and an image extension — so this cannot be used
 * to reach any other address on the API host, or any other host.
 *
 * The files are immutable (every upload gets a new random name), so they are
 * cached for a year.
 */

const API_ORIGIN = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api")
  .replace(/\/$/, "")
  .replace(/\/api$/, "");

const SAFE_PATH = /^products\/[a-f0-9]{32}\.(webp|jpg|jpeg|png|gif)$/;

const TUNNEL_HEADERS: Record<string, string> = ((): Record<string, string> => {
  try {
    return /\.ngrok(-free)?\.(app|dev|io)$/.test(new URL(API_ORIGIN).hostname)
      ? { "ngrok-skip-browser-warning": "true" }
      : {};
  } catch {
    return {};
  }
})();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const path = (await params).path.join("/");
  if (!SAFE_PATH.test(path)) return new Response("Not found", { status: 404 });

  let upstream: Response;
  try {
    upstream = await fetch(`${API_ORIGIN}/uploads/${path}`, {
      headers: TUNNEL_HEADERS,
      cache: "force-cache",
    });
  } catch {
    return new Response("Image unavailable", { status: 502 });
  }

  const type = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !type.startsWith("image/")) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
