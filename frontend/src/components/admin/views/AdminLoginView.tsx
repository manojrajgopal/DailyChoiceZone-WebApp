"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminInput } from "@/components/admin/ui/AdminForm";
import { useAdminSession } from "@/hooks/useAdminSession";

import logoMark from "../../../../public/brand/logo.png";

/**
 * Admin sign-in.
 *
 * Outside the portal layout, so it has no sidebar and is not behind the guard
 * that would otherwise redirect it to itself.
 *
 * Nothing on this page names an account. A sign-in form that prints a working
 * password is a sign-in form with no purpose, and the placeholder below is a
 * format hint rather than an address that exists.
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
                placeholder="you@example.com"
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
