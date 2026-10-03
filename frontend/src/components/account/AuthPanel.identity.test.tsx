import { afterEach, describe, expect, it } from "vitest";

import { stopSessionRefresh } from "@/services/sessionRefresh";
import { useSessionStore } from "@/store/sessionStore";
import { api, fail } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor } from "@/test/render";
import { apiCustomer, authPayload, toastMessages } from "@/test/sliceD-acct1-fixtures";

import { AuthPanel } from "./AuthPanel";

const ALL_METHODS = {
  emailPassword: true,
  emailOtp: true,
  mobileOtp: true,
  providers: [
    { code: "google", label: "Google" },
    { code: "apple", label: "Apple" },
  ],
  signupVerification: "code",
};

function issued(overrides: Record<string, unknown> = {}) {
  return { challengeId: "ch1", channel: "sms", destination: "+91 ******3210", expiresIn: 300, resendIn: 0, length: 6, ...overrides };
}

const codeBox = () => screen.getByLabelText(/^One-time code/);
const submit = () => document.querySelector('form button[type="submit"]') as HTMLButtonElement;

afterEach(() => stopSessionRefresh());

describe("AuthPanel — which ways in are offered", () => {
  it("offers a code and each provider when the store has them on", async () => {
    api.get("/auth/methods", ALL_METHODS);
    renderUI(<AuthPanel />);
    expect(await screen.findByRole("button", { name: "Use a one-time code instead" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue with Apple" })).toBeInTheDocument();
    // The password form is still the first thing on the page.
    expect(screen.getByLabelText(/^Password/)).toBeInTheDocument();
  });

  it("offers neither when the store has only the password on", async () => {
    api.get("/auth/methods", { ...ALL_METHODS, emailOtp: false, mobileOtp: false, providers: [] });
    renderUI(<AuthPanel />);
    await waitFor(() => expect(api.requests("GET", "/auth/methods")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /one-time code/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Continue with/ })).not.toBeInTheDocument();
  });

  it("goes straight to the code when the password is switched off", async () => {
    api.get("/auth/methods", { ...ALL_METHODS, emailPassword: false, providers: [] });
    renderUI(<AuthPanel />);
    expect(await screen.findByRole("button", { name: "Send code" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Password/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use your password instead" })).not.toBeInTheDocument();
  });

  it("stops offering the password form when the server says it was switched off", async () => {
    api.get("/auth/methods", { ...ALL_METHODS, providers: [] });
    api.post("/auth/login", fail(403, "Signing in with a password isn't available right now.", "AUTH_METHOD_DISABLED"));
    const { user } = renderUI(<AuthPanel />);
    await screen.findByRole("button", { name: "Use a one-time code instead" });
    await user.type(screen.getByLabelText(/^Email address/), "a@b.com");
    await user.type(screen.getByLabelText(/^Password/), "hunter22");
    await user.click(submit());
    expect(await screen.findByRole("button", { name: "Send code" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Password/)).not.toBeInTheDocument();
    expect(await toastMessages()).toContain("error: Signing in with a password isn't available right now.");
  });
});

describe("AuthPanel — social sign-in", () => {
  it("sends the browser to the API's start URL with where to come back to", async () => {
    setLocation("/account?next=%2Fcheckout%2Fpayment");
    api.get("/auth/methods", ALL_METHODS);
    renderUI(<AuthPanel />);
    expect(await screen.findByRole("link", { name: "Continue with Google" })).toHaveAttribute(
      "href",
      "http://localhost:8000/api/auth/oauth/google/start?next=%2Fcheckout%2Fpayment&mode=login",
    );
  });

  it("comes back to this page when there is no next, and never to an unsafe one", async () => {
    setLocation("/account?next=%2F%2Fevil.example");
    api.get("/auth/methods", ALL_METHODS);
    renderUI(<AuthPanel />);
    expect(await screen.findByRole("link", { name: "Continue with Apple" })).toHaveAttribute(
      "href",
      "http://localhost:8000/api/auth/oauth/apple/start?next=%2Faccount&mode=login",
    );
  });
});

describe("AuthPanel — signing in with a code", () => {
  it("requests a code by SMS and signs in with it", async () => {
    api.get("/auth/methods", ALL_METHODS);
    api.post("/auth/otp/request", issued());
    api.post("/auth/otp/verify", { status: "signed-in", ...authPayload({ firstName: "Asha" }, "otp-token") });
    const { user } = renderUI(<AuthPanel />);

    await user.click(await screen.findByRole("button", { name: "Use a one-time code instead" }));
    expect(screen.getByRole("radio", { name: "Mobile number" })).toHaveAttribute("aria-checked", "true");
    await user.type(screen.getByLabelText(/^Mobile number/), "98765 43210");
    await user.click(screen.getByRole("button", { name: "Send code" }));

    expect(api.last("POST", "/auth/otp/request")!.body).toEqual({ channel: "sms", destination: "98765 43210", purpose: "login" });
    await user.type(await screen.findByLabelText(/^One-time code/), "123456");

    await waitFor(() => expect(localStorage.getItem("dcz:auth-token")).toBe("otp-token"));
    expect(api.last("POST", "/auth/otp/verify")!.body).toEqual({ challengeId: "ch1", code: "123456" });
    expect(useSessionStore.getState().session?.user.firstName).toBe("Asha");
    expect(await toastMessages()).toContain("success: Welcome back, Asha");
  });

  it("can send the code by email instead", async () => {
    api.get("/auth/methods", ALL_METHODS);
    api.post("/auth/otp/request", issued({ channel: "email", destination: "a***@example.com" }));
    const { user } = renderUI(<AuthPanel />);
    await user.click(await screen.findByRole("button", { name: "Use a one-time code instead" }));
    await user.click(screen.getByRole("radio", { name: "Email" }));
    await user.type(screen.getByLabelText(/^Email address/), "asha@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByText("a***@example.com")).toBeInTheDocument();
    expect(api.last("POST", "/auth/otp/request")!.body.channel).toBe("email");
  });

  it("shows an invalid number on the field", async () => {
    api.get("/auth/methods", ALL_METHODS);
    api.post("/auth/otp/request", fail(422, "Enter a valid mobile number, e.g. 98765 43210.", "PHONE_INVALID"));
    const { user } = renderUI(<AuthPanel />);
    await user.click(await screen.findByRole("button", { name: "Use a one-time code instead" }));
    await user.type(screen.getByLabelText(/^Mobile number/), "123");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid mobile number, e.g. 98765 43210.");
    expect(screen.getByLabelText(/^Mobile number/)).toHaveAttribute("aria-invalid", "true");
  });

  it("says when too many codes have been asked for", async () => {
    api.get("/auth/methods", ALL_METHODS);
    api.post("/auth/otp/request", fail(429, "Too many codes. Try again later.", "OTP_TOO_MANY"));
    const { user } = renderUI(<AuthPanel />);
    await user.click(await screen.findByRole("button", { name: "Use a one-time code instead" }));
    await user.type(screen.getByLabelText(/^Mobile number/), "9876543210");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many codes. Try again later.");
  });

  it("creates an account when nobody has that number yet, asking for an email", async () => {
    setLocation("/account?next=%2Fcheckout%2Fpayment");
    api.get("/auth/methods", ALL_METHODS);
    api.post("/auth/otp/request", issued());
    api.post("/auth/otp/verify", { status: "signup-required", signupToken: "signup-token-abc", channel: "sms", destination: "+91 ******3210" });
    api.post("/auth/otp/signup", authPayload({ firstName: "Ravi" }, "fresh"));
    const { user } = renderUI(<AuthPanel />);

    await user.click(await screen.findByRole("button", { name: "Use a one-time code instead" }));
    await user.type(screen.getByLabelText(/^Mobile number/), "9876543210");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByLabelText(/^One-time code/), "123456");

    const first = await screen.findByLabelText(/^First name/);
    expect(first).toHaveFocus();
    expect(screen.getByLabelText(/^Email address/)).toBeRequired();
    await user.type(first, "Ravi");
    await user.type(screen.getByLabelText(/^Email address/), "ravi@example.com");
    await user.click(submit());

    await waitFor(() => expect(localStorage.getItem("dcz:auth-token")).toBe("fresh"));
    expect(api.last("POST", "/auth/otp/signup")!.body).toMatchObject({
      signupToken: "signup-token-abc",
      firstName: "Ravi",
      email: "ravi@example.com",
      marketingOptIn: true,
    });
    expect(await toastMessages()).toContain("success: Account created");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/checkout/payment"));
  });

  it("does not ask for an email when the code came by email", async () => {
    api.get("/auth/methods", { ...ALL_METHODS, mobileOtp: false });
    api.post("/auth/otp/request", issued({ channel: "email", destination: "r***@example.com" }));
    api.post("/auth/otp/verify", { status: "signup-required", signupToken: "signup-token-abc", channel: "email", destination: "r***@example.com" });
    const { user } = renderUI(<AuthPanel />);
    await user.click(await screen.findByRole("button", { name: "Use a one-time code instead" }));
    await user.type(screen.getByLabelText(/^Email address/), "ravi@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByLabelText(/^One-time code/), "123456");
    await screen.findByLabelText(/^First name/);
    expect(screen.queryByLabelText(/^Email address/)).not.toBeInTheDocument();
  });

  it("starts over when the sign-up has expired", async () => {
    api.get("/auth/methods", ALL_METHODS);
    api.post("/auth/otp/request", issued());
    api.post("/auth/otp/verify", { status: "signup-required", signupToken: "signup-token-abc", channel: "sms", destination: "+91 ******3210" });
    api.post("/auth/otp/signup", fail(401, "This sign-up has expired. Ask for a new code.", "SIGNUP_EXPIRED"));
    const { user } = renderUI(<AuthPanel />);
    await user.click(await screen.findByRole("button", { name: "Use a one-time code instead" }));
    await user.type(screen.getByLabelText(/^Mobile number/), "9876543210");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByLabelText(/^One-time code/), "123456");
    await user.type(await screen.findByLabelText(/^First name/), "Ravi");
    await user.type(screen.getByLabelText(/^Email address/), "ravi@example.com");
    await user.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent("This sign-up has expired. Ask for a new code.");
    expect(screen.getByRole("button", { name: "Send code" })).toBeInTheDocument();
    expect(localStorage.getItem("dcz:auth-token")).toBeNull();
  });

  it("says how many tries are left after a wrong code", async () => {
    api.get("/auth/methods", ALL_METHODS);
    api.post("/auth/otp/request", issued());
    api.post("/auth/otp/verify", fail(400, "That code isn't right. 4 tries left.", "OTP_INCORRECT", { attemptsLeft: 4 }));
    const { user } = renderUI(<AuthPanel />);
    await user.click(await screen.findByRole("button", { name: "Use a one-time code instead" }));
    await user.type(screen.getByLabelText(/^Mobile number/), "9876543210");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByLabelText(/^One-time code/), "000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't right. 4 tries left.");
    expect(codeBox()).toHaveFocus();
  });
});

describe("AuthPanel — registering when new accounts confirm with a code", () => {
  const EMAIL_CODE = issued({ challengeId: "em1", channel: "email", destination: "p***@example.com" });
  const PHONE_CODE = issued({ challengeId: "ph1" });

  async function registerWith(user: ReturnType<typeof renderUI>["user"], { phone = "" } = {}) {
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await user.type(screen.getByLabelText(/^First name/), "Priya");
    await user.type(screen.getByLabelText(/^Email address/), "priya@example.com");
    await user.type(screen.getByLabelText(/^Password/), "hunter22");
    if (phone) await user.type(screen.getByLabelText(/^Mobile number/), phone);
    await user.click(submit());
  }

  it("offers a phone field, and takes the email then the phone code before signing in", async () => {
    signInStoreIsEmpty();
    api.get("/auth/methods", ALL_METHODS);
    api.post("/auth/register", { ...authPayload({ firstName: "Priya" }), verification: EMAIL_CODE, phoneVerification: PHONE_CODE });
    api.post("/account/email/verify-code", apiCustomer({ firstName: "Priya", emailVerified: true }));
    api.post("/account/phone/verify", { phone: "+919876543210", phoneVerified: true });
    const { user } = renderUI(<AuthPanel />);
    await screen.findByRole("button", { name: "Use a one-time code instead" });

    await registerWith(user, { phone: "98765 43210" });
    expect(api.last("POST", "/auth/register")!.body.phone).toBe("9876543210");

    // Account made and token stored, but the panel stays for the codes.
    expect(await screen.findByRole("heading", { name: "Confirm your email address" })).toBeInTheDocument();
    expect(localStorage.getItem("dcz:auth-token")).toBe("new-token");
    expect(useSessionStore.getState().session).toBeNull();

    await user.type(codeBox(), "111111");
    expect(await screen.findByRole("heading", { name: "Confirm your mobile number" })).toBeInTheDocument();
    expect(api.last("POST", "/account/email/verify-code")!.body).toEqual({ challengeId: "em1", code: "111111" });
    expect(api.last("POST", "/account/email/verify-code")!.headers.authorization).toBe("Bearer new-token");

    await user.type(codeBox(), "222222");
    await waitFor(() => expect(useSessionStore.getState().session).not.toBeNull());
    expect(api.last("POST", "/account/phone/verify")!.body).toEqual({ challengeId: "ph1", code: "222222" });
    const signedIn = useSessionStore.getState().session!.user;
    expect(signedIn.emailVerified).toBe(true);
    expect(signedIn.phoneVerified).toBe(true);
  });

  it("can leave the codes for later, without claiming anything is confirmed", async () => {
    api.get("/auth/methods", ALL_METHODS);
    api.post("/auth/register", { ...authPayload({ emailVerified: false }), verification: EMAIL_CODE, phoneVerification: null });
    const { user } = renderUI(<AuthPanel />);
    await screen.findByRole("button", { name: "Use a one-time code instead" });
    await registerWith(user);
    await screen.findByRole("heading", { name: "Confirm your email address" });
    await user.click(screen.getByRole("button", { name: "Do this later" }));
    await waitFor(() => expect(useSessionStore.getState().session).not.toBeNull());
    expect(useSessionStore.getState().session!.user.emailVerified).toBe(false);
  });

  it("resends the email code from the account endpoint", async () => {
    api.get("/auth/methods", ALL_METHODS);
    api.post("/auth/register", { ...authPayload(), verification: EMAIL_CODE });
    api.post("/account/email/code", { ...EMAIL_CODE, challengeId: "em2", alreadyVerified: false });
    const { user } = renderUI(<AuthPanel />);
    await screen.findByRole("button", { name: "Use a one-time code instead" });
    await registerWith(user);
    await screen.findByRole("heading", { name: "Confirm your email address" });
    await user.click(screen.getByRole("button", { name: "Send a new code" }));
    expect(await screen.findByText("We've sent a new code to p***@example.com.")).toBeInTheDocument();
    expect(api.requests("POST", "/account/email/code")).toHaveLength(1);
  });

  it("refuses a malformed phone number before sending anything", async () => {
    api.get("/auth/methods", ALL_METHODS);
    const { user } = renderUI(<AuthPanel />);
    await screen.findByRole("button", { name: "Use a one-time code instead" });
    await registerWith(user, { phone: "12345" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a 10-digit mobile number, or leave it blank.");
    expect(api.requests("POST", "/auth/register")).toHaveLength(0);
  });

  it("signs straight in when the store confirms by link", async () => {
    api.get("/auth/methods", { ...ALL_METHODS, signupVerification: "link" });
    api.post("/auth/register", authPayload({ firstName: "Priya" }));
    const { user } = renderUI(<AuthPanel />);
    await screen.findByRole("button", { name: "Use a one-time code instead" });
    await registerWith(user);
    await waitFor(() => expect(useSessionStore.getState().session).not.toBeNull());
    expect(screen.queryByRole("heading", { name: /Confirm your/ })).not.toBeInTheDocument();
  });
});

/** Nothing signed in before the test. */
function signInStoreIsEmpty() {
  expect(useSessionStore.getState().session).toBeNull();
}
