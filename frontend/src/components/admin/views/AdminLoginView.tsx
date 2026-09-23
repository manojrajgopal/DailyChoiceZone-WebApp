"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, Info, ShieldAlert } from "lucide-react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminInput } from "@/components/admin/ui/AdminForm";
import { useAdminSession } from "@/hooks/useAdminSession";
import { DEMO_CREDENTIALS } from "@/services/admin/adminAuthService";

import logoMark from "../../../../public/brand/logo.png";

/**
 * Admin sign-in.
 *
 * Outside the portal layout, so it has no sidebar and is not behind the guard
 * that would otherwise redirect it to itself.
 *
 * The demo credentials are shown on the page deliberately: this is a
 * frontend-only portal with no auth backend, and a login form whose password
 * nobody can discover is just a locked door with no key. The notice below says
 * plainly what that means.
 */
export function AdminLoginView() {
  const router = useRouter();
  const { signIn, isSignedIn, isLoading } = useAdminSession();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in — skip the form.
  useEffect(() => {
    if (!isLoading && isSignedIn) router.replace("/admin/dashboard");
  }, [isLoading, isSignedIn, router]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const result = await signIn({ email, password });

    if (result.ok) {
      router.replace("/admin/dashboard");
      return;
    }

    setError(result.reason);
    setSubmitting(false);
  };

  const fillDemo = () => {
    setEmail(DEMO_CREDENTIALS.email);
    setPassword(DEMO_CREDENTIALS.password);
    setError(null);
  };

  return (
    <div className="flex min-h-dvh flex-col bg-admin-plane">
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          {/* ------------------------------------------------------ brand */}
          <div className="mb-8 flex flex-col items-center text-center">
            <Image
              src={logoMark}
              alt=""
              aria-hidden="true"
              priority
              className="h-14 w-14 rounded-pill object-contain"
              sizes="56px"
            />
            <h1 className="mt-4 font-sans text-lg font-semibold tracking-tight text-admin-ink">
              Daily Choice Zone
            </h1>
            <p className="mt-0.5 text-[0.6875rem] uppercase tracking-[0.18em] text-admin-muted">
              Admin portal
            </p>
          </div>

          {/* ------------------------------------------------------- form */}
          <form
            onSubmit={onSubmit}
            className="rounded-[3px] border border-admin-border bg-admin-surface p-5"
          >
            <div className="flex flex-col gap-4">
              <AdminInput
                label="Email address"
                type="email"
                name="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="admin@dailychoicezone.com"
                required
                autoFocus
              />

              <AdminInput
                label="Password"
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>

            {error ? (
              <p
                role="alert"
                className="mt-4 rounded-[3px] bg-[#fbeaea] px-3 py-2 text-xs text-[#a32424]"
              >
                {error}
              </p>
            ) : null}

            <AdminButton
              type="submit"
              variant="primary"
              loading={submitting}
              className="mt-5 w-full"
            >
              Sign in
            </AdminButton>
          </form>

          {/* ------------------------------------------------ demo notice */}
          <div className="mt-4 rounded-[3px] border border-copper-200 bg-copper-50 p-3.5">
            <p className="flex items-center gap-2 text-xs font-medium text-admin-ink">
              <Info className="h-3.5 w-3.5 text-copper-700" strokeWidth={1.75} aria-hidden="true" />
              Demo credentials
            </p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.6875rem] text-admin-muted">
              <dt>Email</dt>
              <dd className="font-mono text-admin-ink">{DEMO_CREDENTIALS.email}</dd>
              <dt>Password</dt>
              <dd className="font-mono text-admin-ink">{DEMO_CREDENTIALS.password}</dd>
            </dl>
            <button
              type="button"
              onClick={fillDemo}
              className="mt-2.5 text-[0.6875rem] font-medium text-copper-700 underline underline-offset-2 hover:text-admin-ink"
            >
              Fill these in
            </button>
          </div>

          {/* ------------------------------------------- security honesty */}
          <div className="mt-3 flex items-start gap-2.5 rounded-[3px] border border-admin-border bg-admin-surface p-3.5">
            <ShieldAlert
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-admin-faint"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <p className="text-[0.625rem] leading-relaxed text-admin-muted">
              This check runs in your browser, so it is not security — it gives the portal the
              shape of an authenticated app while there is no backend. Do not put real customer
              data behind it.
            </p>
          </div>

          <Link
            href="/"
            className="mt-6 inline-flex items-center gap-1.5 text-xs text-admin-muted transition-colors hover:text-admin-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Back to the storefront
          </Link>
        </div>
      </div>
    </div>
  );
}
