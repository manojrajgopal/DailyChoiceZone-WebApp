# Authentication: sign-in methods, codes, providers and sessions

Customers can sign in in four ways:

- email and password, as before
- a one-time code by text message
- a one-time code by email
- Google, Apple or Microsoft (OpenID Connect)

They confirm a phone number with a code the first time they add it and every
time they change it, and they can see and sign out their devices. The portal
switches each method on or off.

- **Backend:**
  - `app/services/identity/`: `oauth.py`, `accounts.py`, `methods.py`,
    `google.py`, `apple.py`, `microsoft.py`, `registry.py`, `base.py`
  - `app/services/otp.py` and `otp_providers.py`
  - `app/services/sessions.py`
  - routes in `app/api/routes/identity.py` and `routes/auth.py`
  - models in `app/models/identity.py`
  - migration `20261008_1300_identity_otp_sessions`
- **Storefront:**
  - `components/account/AuthPanel.tsx`
  - `components/account/auth/`: `OtpSignIn`, `CodeStep`, `OtpCodeInput`, `SocialButtons`, `RegisterVerification`
  - `AuthCompleteView.tsx` at `/auth/complete`
  - `PhoneVerifyDialog.tsx`
  - `SecuritySettings.tsx` (under Settings)
  - `services/identityService.ts` and `services/sessionRefresh.ts`
- **Portal:** Settings → Authentication
  (`components/admin/views/auth/AdminAuthenticationView.tsx`), backed by
  `services/admin/authMethodsAdminService.ts`. It needs the permission
  `auth-settings`.

## Rules the backend keeps

- **Codes are never stored in plain text.**
  - Each code is a keyed hash bound to its challenge id.
  - The phone number or email it was sent to is sealed (encrypted). The API
    shows it only masked (`+91•••••43210`).
  - Codes are never logged.
- **Code limits.**
  - Codes are 6 digits (`OTP_LENGTH`, 4–8), valid for 5 minutes, allow 5 tries,
    and can be resent after 45 s.
  - A new code supersedes the older one for the same destination and purpose.
  - Rate limits:
    - 5 codes per hour and 10 per day per destination
    - 20 per hour per IP address
    - 10 per hour per account
  - Verifying is limited too.
- **No account enumeration.** Asking for a code gives the same answer whether
  or not an account exists. Verifying it either signs the person in or returns
  a short-lived sign-up token.
- **Provider sign-in.**
  - Each trip has a single-use `state`, bound to the browser by an HttpOnly
    cookie, a `nonce` inside the signed id token, and PKCE S256 (Google and
    Microsoft; Apple doesn't support it on the web).
  - Only the provider's verified id token is trusted. The browser gets back a
    120-second single-use hand-off code, never a token in the URL.
- **Account matching.**
  - A provider's verified email joins an existing account only when that
    account's email is verified too. Otherwise the person is asked to sign in
    first and connect the provider from Settings (`account_exists`).
  - An Apple private relay address (`…@privaterelay.appleid.com`) never finds
    an account; only Apple's `sub` does.
- **Sessions.**
  - Every token carries a session id (`sid`). Sessions last 30 days
    (`SESSION_LIFETIME_DAYS`).
  - The storefront refreshes its token 2 minutes before it expires
    (`POST /auth/session/refresh`).
  - A revoked or expired session answers 401 `SESSION_REVOKED` /
    `SESSION_EXPIRED`, and the storefront signs out locally.
  - Changing or setting a password signs out every other device.
- **You can't lock yourself out.** The last way into an account (password,
  verified phone or a provider) can't be removed (`LAST_SIGN_IN_METHOD`). The
  portal refuses a set-up in which nobody could sign in (`NO_SIGN_IN_METHOD`).
- **Caller IP address.** Rate limits key on the caller's IP address.
  `X-Forwarded-For` is believed only from a proxy listed in `TRUSTED_PROXIES`
  (default `127.0.0.1,::1`), and is then read right to left. Put your load
  balancer's address there in production, or every caller looks like the
  proxy.
- **Audit and notices.** Sign-ups, linking, unlinking, phone changes, password
  changes and device sign-outs are audited, and the customer is emailed about
  security-relevant changes (for example, "Google is now connected").

## API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/auth/methods` | Which methods the sign-in page offers (nothing about why one is missing) |
| POST | `/api/auth/otp/request` | `{channel: sms\|email, destination, purpose: login\|signup}` → `{challengeId, destination (masked), expiresIn, resendIn, length}` |
| POST | `/api/auth/otp/verify` | `{challengeId, code}` → `signed-in` with a token, or `signup-required` with a sign-up token |
| POST | `/api/auth/otp/signup` | `{signupToken, firstName, lastName?, email?}`; email is required when the code came by SMS |
| GET | `/api/auth/oauth/{provider}/start?next=&mode=login\|link` | Full-page redirect to the provider |
| GET/POST | `/api/auth/oauth/{provider}/callback` | The provider's return. Sends the browser on to `/auth/complete?code=…\|linked=…\|error=…` |
| POST | `/api/auth/oauth/complete` | `{code}` → token and customer |
| POST | `/api/auth/session/refresh` | A new token for the same session |
| GET | `/api/account/security` | Email and phone state, password set, linked providers, ways in |
| POST/DELETE | `/api/account/identities/{provider}/link`, `/api/account/identities/{id}` | Connect a provider (returns a URL to open) or disconnect one |
| POST | `/api/account/phone/otp`, `/api/account/phone/verify` | Add or change the phone with a code |
| DELETE | `/api/account/phone` | Remove the phone |
| POST | `/api/account/email/code`, `/api/account/email/verify-code` | Confirm the email with a code |
| POST | `/api/account/password/otp`, `/api/account/password/set` | Set a first password with an emailed code |
| GET/DELETE | `/api/account/sessions`, `/api/account/sessions/{id}` | List devices, or sign one out |
| POST | `/api/account/sessions/revoke-others` | Sign out every other device; returns a new token |
| GET/PUT | `/api/admin/auth/methods` | Portal: switches, set-up state, redirect URIs, today's numbers |

Error codes, as the storefront shows them:

- **Codes:** `OTP_INCORRECT` (with `attemptsLeft`), `OTP_EXPIRED`,
  `OTP_LOCKED`, `OTP_USED`, `OTP_SUPERSEDED`, `OTP_RESEND_WAIT` (with
  `retryAfter`), `OTP_TOO_MANY`, `OTP_SEND_FAILED`, `PHONE_INVALID`,
  `EMAIL_INVALID`.
- **Accounts:** `AUTH_METHOD_DISABLED`, `PHONE_IN_USE`, `EMAIL_TAKEN`,
  `EMAIL_REQUIRED`, `SIGNUP_EXPIRED`, `LAST_SIGN_IN_METHOD`.
- **Providers**, in `/auth/complete?error=`: `cancelled`,
  `provider_unavailable`, `invalid_state`, `invalid_token`,
  `identity_in_use`, `account_exists`, `email_missing`, `email_unverified`,
  `not_configured`, `account_blocked`, `already_linked`, `failed`.

## Setting up (backend `.env`)

| Variable | Use |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google |
| `APPLE_CLIENT_ID` (Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Apple. The client secret is a short-lived ES256 JWT made per request. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT` | Microsoft (`common`, `consumers` or a tenant id) |
| `OTP_SMS_PROVIDER` | `console` (development: the code goes to the log), `twilio`, `msg91` or `none` |
| `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`, Twilio keys, `OTP_SENDER_ID` | The SMS provider |
| `OTP_LENGTH`, `OTP_EXPIRY_SECONDS`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_SECONDS`, `OTP_PER_*` | Code rules and limits |
| `SESSION_LIFETIME_DAYS` | How long a device stays signed in |
| `TRUSTED_PROXIES` | Proxies whose `X-Forwarded-For` is believed |

Register each provider's redirect URI as `<PUBLIC_API_URL>/api/auth/oauth/<provider>/callback`.
Settings → Authentication shows the exact address with a copy button. Email
codes are sent through the store's email account (Settings → Email). In
production a method only appears when its keys are set: the portal shows "Not
set up" with the reason, and secrets are never shown or entered there.

## Storefront behaviour

- **Sign-in panel** (`/account`):
  - Shows only the methods that are on: password tabs, "Use a one-time code
    instead" (mobile number or email), and "Continue with Google / Apple /
    Microsoft".
  - The code box accepts paste and the phone's one-time-code autofill. It
    counts down to resend and shows the tries left.
- **Registration:** with "code" or "both" confirmation, the email code and
  then the phone code (if a phone was given and text codes are on) are asked
  for on the same panel. Each can be done later from Settings.
- **The default is "both":** a new account is asked for the emailed code on
  the sign-up page, and the link is still sent for someone who closes the
  page. Settings → Authentication can switch it to "link" or "code" only.
- **`/auth/complete`:** finishes a provider sign-in or a connection. It only
  follows a `next` path on this site and shows a friendly message for every
  error code.
- **Profile:** the phone shows Verified or Not verified. Changing it needs a
  texted code. A number typed into the profile alone stays unverified.
- **Settings → Security:**
  - ways to sign in
  - email confirmation
  - phone add, change and remove
  - connected accounts (connect and disconnect)
  - set or change the password
  - signed-in devices (sign out one, or all others)
- **Sign-out** clears the session and this device's recent searches.

## Tests

Backend:

- `test_oauth_flow.py` (providers, state, PKCE, matching, Apple, Microsoft, linking)
- `test_otp_auth.py`
- `test_account_security.py`
- `test_sessions.py`
- `test_auth_methods_admin.py`
- `test_auth_dependencies.py` (`client_ip` and trusted proxies)

Frontend:

- `AuthPanel.identity.test.tsx`
- `AuthCompleteView.test.tsx`
- `auth/CodeStep.test.tsx`
- `PhoneVerifyDialog.test.tsx`
- `SecuritySettings.test.tsx`
- `identityService.test.ts`
- `sessionRefresh.test.ts`
- `authService.identity.test.ts`
- `AdminAuthenticationView.test.tsx`
