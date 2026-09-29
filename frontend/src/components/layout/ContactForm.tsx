"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { useSiteContent } from "@/hooks/useSiteContent";
import { toast } from "@/store/toastStore";

/**
 * The contact form.
 *
 * A valid message is handed to the customer's own email app, addressed to the
 * store and filled in, so it arrives with their reply address attached. When
 * a support inbox service is connected, only `onSubmit` changes.
 */
export function ContactForm({ supportEmail }: { supportEmail: string }) {
  const topics = useSiteContent()?.contactTopics ?? [];

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

    const topicLabel = topics.find((entry) => entry.value === topic)?.label ?? topic;
    const subject = `${topicLabel}${orderNumber.trim() ? ` — order ${orderNumber.trim()}` : ""}`;
    const body = [
      message.trim(),
      "",
      `Name: ${name.trim()}`,
      `Email: ${email.trim()}`,
      orderNumber.trim() ? `Order number: ${orderNumber.trim()}` : "",
    ]
      .filter((line, index) => line || index < 2)
      .join(String.fromCharCode(10));

    window.location.href = `mailto:${supportEmail}?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(body)}`;

    toast.success("Your email app is opening with your message ready to send.");
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
          options={topics}
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
        Sending opens your email app with your message ready to go. You can also write to us at{" "}
        <a href={`mailto:${supportEmail}`} className="underline underline-offset-2 hover:text-ink">
          {supportEmail}
        </a>
        . We reply within one working day.
      </p>
    </form>
  );
}
