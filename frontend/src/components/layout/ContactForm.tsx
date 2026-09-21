"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { toast } from "@/store/toastStore";

const TOPICS = [
  { value: "order", label: "A question about my order" },
  { value: "return", label: "A return or exchange" },
  { value: "product", label: "A question about a product" },
  { value: "delivery", label: "Delivery or tracking" },
  { value: "other", label: "Something else" },
];

/**
 * The contact form.
 *
 * Frontend only: a valid submission confirms and clears, and nothing is sent
 * anywhere. When a support endpoint exists, only `onSubmit` changes.
 */
export function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [topic, setTopic] = useState("order");
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<{ name?: string; email?: string; message?: string }>({});

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    const next: typeof errors = {};
    if (name.trim().length < 2) next.name = "Enter your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      next.email = "Enter a valid email address.";
    }
    if (message.trim().length < 15) {
      next.message = "Please give us a little more detail (at least 15 characters).";
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setName("");
    setEmail("");
    setOrderNumber("");
    setMessage("");
    toast.success("Thanks — we will reply within one working day");
  };

  return (
    <form onSubmit={onSubmit} className="max-w-xl">
      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          label="Your name"
          autoComplete="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((current) => ({ ...current, name: undefined }));
          }}
          error={errors.name}
          required
        />

        <Input
          label="Email address"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setErrors((current) => ({ ...current, email: undefined }));
          }}
          error={errors.email}
          placeholder="you@example.com"
          required
        />

        <Select
          label="What is it about?"
          options={TOPICS}
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
        />

        <Input
          label="Order number"
          value={orderNumber}
          onChange={(event) => setOrderNumber(event.target.value)}
          hint="Optional — it helps us find things faster."
          placeholder="DCZ-4F8210"
        />

        <Textarea
          label="Message"
          rows={6}
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            setErrors((current) => ({ ...current, message: undefined }));
          }}
          error={errors.message}
          required
          className="sm:col-span-2"
        />
      </div>

      <Button type="submit" size="lg" className="mt-6">
        Send message
      </Button>

      <p className="mt-4 text-xs leading-relaxed text-ink-400">
        This demo form does not send anything — nothing you type here leaves your browser.
      </p>
    </form>
  );
}
