"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { CheckoutShell } from "@/components/checkout/CheckoutShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { useSession } from "@/hooks/useSession";
import { useCheckoutStore } from "@/store/checkoutStore";

import Link from "next/link";

/** Step 1 — who the order is for and how to reach them. */
export default function CheckoutContactPage() {
  const router = useRouter();
  const { user, isSignedIn } = useSession();
  const contact = useCheckoutStore((state) => state.contact);
  const setContact = useCheckoutStore((state) => state.setContact);

  const [email, setEmail] = useState(contact.email);
  const [phone, setPhone] = useState(contact.phone);
  const [errors, setErrors] = useState<{ email?: string; phone?: string }>({});

  /**
   * Seed the form once persisted state and the session have hydrated.
   *
   * Both sources arrive after first render, so this cannot be done in
   * `useState`. A field is only ever filled while still empty, so restoring a
   * value can never overwrite something the shopper has typed.
   */
  useEffect(() => {
    setEmail((current) => current || contact.email || user?.email || "");
    setPhone((current) => current || contact.phone || user?.phone || "");
  }, [contact.email, contact.phone, user?.email, user?.phone]);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    const next: { email?: string; phone?: string } = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      next.email = "Enter a valid email address.";
    }
    // Indian mobile numbers: 10 digits starting 6–9.
    if (!/^[6-9]\d{9}$/.test(phone.replace(/\D/g, ""))) {
      next.phone = "Enter a 10-digit mobile number.";
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setContact({ email: email.trim(), phone: phone.replace(/\D/g, "") });
    router.push("/checkout/address");
  };

  return (
    <CheckoutShell
      title="Contact details"
      description="We will send your order confirmation and delivery updates here."
    >
      <form onSubmit={onSubmit} className="max-w-md">
        <div className="flex flex-col gap-5">
          <Input
            label="Email address"
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={errors.email}
            required
            placeholder="you@example.com"
          />

          <Input
            label="Mobile number"
            type="tel"
            name="phone"
            autoComplete="tel"
            inputMode="numeric"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            error={errors.phone}
            hint="For delivery updates only. No marketing calls."
            required
            placeholder="98765 43210"
          />
        </div>

        {!isSignedIn ? (
          <p className="mt-6 rounded-card bg-cream-deep p-3.5 text-xs leading-relaxed text-ink-700">
            Checking out as a guest.{" "}
            <Link
              href="/account"
              className="underline decoration-ink-300 underline-offset-2 transition-colors hover:text-copper-700"
            >
              Sign in
            </Link>{" "}
            to save your details and track this order from your account.
          </p>
        ) : null}

        <Button type="submit" size="lg" className="mt-8" fullWidth>
          Continue to delivery
        </Button>
      </form>
    </CheckoutShell>
  );
}
