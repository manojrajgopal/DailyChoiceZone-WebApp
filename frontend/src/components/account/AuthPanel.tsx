"use client";

import { useState } from "react";
import { Info } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { useSession } from "@/hooks/useSession";

/**
 * Sign in and register, on one panel.
 *
 * Mock authentication — any valid-looking email with a six-character password
 * is accepted, and no password is ever stored. The notice makes that explicit
 * so nobody types a real password expecting real security.
 */
export function AuthPanel() {
  const { signIn, register } = useSession();
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    try {
      if (mode === "signin") {
        await signIn({ email, password });
      } else {
        await register({ firstName, lastName, email, password });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-8 flex gap-6 border-b border-ink-200">
        {(
          [
            ["signin", "Sign in"],
            ["register", "Create account"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            aria-pressed={mode === value}
            className={
              mode === value
                ? "-mb-px border-b-2 border-ink pb-3 label-wide text-ink"
                : "-mb-px border-b-2 border-transparent pb-3 label-wide text-ink-400 transition-colors hover:text-ink-700"
            }
          >
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        {mode === "register" ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <Input
              label="First name"
              autoComplete="given-name"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              required
            />
            <Input
              label="Last name"
              autoComplete="family-name"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
            />
          </div>
        ) : null}

        <Input
          label="Email address"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          required
        />

        <Input
          label="Password"
          type="password"
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint="At least 6 characters."
          required
        />

        <Button type="submit" size="lg" disabled={isSubmitting} fullWidth className="mt-2">
          {isSubmitting
            ? "Please wait…"
            : mode === "signin"
              ? "Sign in"
              : "Create account"}
        </Button>
      </form>

      <div className="mt-8 flex items-start gap-3 rounded-card border border-copper-200 bg-copper-50 p-4">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-copper-700" strokeWidth={1.75} aria-hidden="true" />
        <div className="text-xs leading-relaxed text-ink-700">
          <p className="font-medium text-ink">Demo sign-in</p>
          <p className="mt-1">
            There is no authentication backend yet, so any valid email and a password of six or
            more characters will sign you in. Nothing is sent anywhere and no password is stored —
            please do not use a real one.
          </p>
        </div>
      </div>
    </div>
  );
}
