/**
 * Shared setup for the admin-service tests in `services/admin/**`.
 *
 * Most of those services are thin, single-purpose calls to one `/admin/...`
 * endpoint (method, path, query, body, the admin bearer token). Rather than
 * repeat the plumbing in every test file, each one:
 *
 *   - calls `installAdminDefaults()` to answer every GET/POST/PUT/DELETE with
 *     an empty object unless the test registers something more specific
 *     (later registrations win — see `src/test/api.ts`);
 *   - signs in as an admin, so `api.last()!.headers.authorization` is always
 *     the bearer token a real request would carry;
 *   - reads back the exact request with `api.last(method, path)`.
 */
import { signIn } from "@/test/render";

import { api } from "./api";

/** Answers every admin request with `{}` (a 200 envelope with no data) unless overridden per test. */
export function installAdminDefaults(): void {
  api.get(/.*/, {});
  api.post(/.*/, {});
  api.put(/.*/, {});
  api.delete(/.*/, {});
}

/** `installAdminDefaults()` plus an admin bearer token in local storage. */
export function setUpAdmin(): void {
  installAdminDefaults();
  signIn("admin");
}
