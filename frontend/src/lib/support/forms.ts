/**
 * The extra questions each kind of request asks.
 *
 * Which set a request gets is configuration — the category the customer picks
 * names a form, and the store edits that in the portal. What each form asks is
 * here, and its keys are exactly the ones the API accepts
 * (`DETAIL_FIELDS` in `services/support/tickets.py`); anything else would be
 * dropped on arrival.
 */

import type { SupportForm } from "@/services/supportService";

export interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "date" | "email" | "url" | "number";
  required?: boolean;
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  /** Longest accepted value, as the API trims it. */
  max: number;
  /** Take the whole row on wide screens. */
  wide?: boolean;
}

export interface FormSpec {
  /** Offer the customer's own orders (or ask for a number, for a guest). */
  order?: "optional" | "required";
  /** Offer the products in the chosen order. */
  product?: boolean;
  /** What the description box asks for. */
  descriptionLabel: string;
  descriptionPlaceholder: string;
  /** Screenshots matter here — say so beside the upload. */
  attachmentHint?: string;
  fields: FieldSpec[];
}

const PAYMENT_METHODS = [
  { value: "", label: "Choose one" },
  { value: "UPI", label: "UPI" },
  { value: "Card", label: "Debit / credit card" },
  { value: "Net banking", label: "Net banking" },
  { value: "Wallet", label: "Wallet" },
  { value: "Cash on delivery", label: "Cash on delivery" },
];

export const FORMS: Record<SupportForm, FormSpec> = {
  order: {
    order: "optional",
    descriptionLabel: "What's happened?",
    descriptionPlaceholder: "Tell us what you expected and what happened instead.",
    attachmentHint: "A photo of the parcel or the item helps with missing or wrong items.",
    fields: [],
  },
  product: {
    order: "optional",
    product: true,
    descriptionLabel: "Describe the problem",
    descriptionPlaceholder: "What's wrong with the product? When did you notice it?",
    attachmentHint: "Photos of the product and its packaging help us sort this quickly.",
    fields: [{ key: "productName", label: "Product", type: "text", max: 200, placeholder: "If it isn't in an order above" }],
  },
  delivery: {
    order: "optional",
    descriptionLabel: "What's happened with the delivery?",
    descriptionPlaceholder: "When was it due, and what does the tracking say?",
    fields: [
      { key: "trackingNumber", label: "Tracking number", type: "text", max: 60 },
      { key: "deliveryAddress", label: "Delivery address", type: "textarea", max: 500, hint: "Only if it needs changing.", wide: true },
    ],
  },
  payment: {
    order: "optional",
    descriptionLabel: "What happened with the payment?",
    descriptionPlaceholder: "For example: the money left my account but the order says payment failed.",
    attachmentHint: "A screenshot of the bank or UPI app's transaction screen is the fastest way to trace it.",
    fields: [
      { key: "paymentMethod", label: "Payment method", type: "select", options: PAYMENT_METHODS, max: 30 },
      {
        key: "transactionRef",
        label: "Transaction reference",
        type: "text",
        max: 80,
        placeholder: "UTR / reference number",
        hint: "Shown in your bank or UPI app against the payment.",
      },
      { key: "amount", label: "Amount (₹)", type: "number", max: 20 },
      { key: "paymentDate", label: "Date of payment", type: "date", max: 20 },
    ],
  },
  membership: {
    descriptionLabel: "How can we help with your membership?",
    descriptionPlaceholder: "Tell us what you'd like to know or change.",
    fields: [{ key: "planName", label: "Plan", type: "text", max: 80, placeholder: "If you know it" }],
  },
  account: {
    descriptionLabel: "What's the problem?",
    descriptionPlaceholder: "What were you trying to do, and what happened?",
    fields: [
      { key: "accountEmail", label: "Email on the account", type: "email", max: 255, hint: "If different from the one above." },
      { key: "device", label: "Device", type: "text", max: 120, placeholder: "e.g. iPhone 13, Windows laptop" },
    ],
  },
  bug: {
    descriptionLabel: "Summary",
    descriptionPlaceholder: "In a sentence or two, what isn't working?",
    attachmentHint: "A screenshot or a short screen recording shows us exactly what you saw.",
    fields: [
      { key: "pageUrl", label: "Page", type: "url", max: 500, placeholder: "https://…", hint: "The address of the page where it happened.", wide: true },
      { key: "steps", label: "Steps to reproduce", type: "textarea", required: true, max: 3000, placeholder: "1. Open …\n2. Tap …\n3. …", wide: true },
      { key: "expected", label: "What you expected", type: "textarea", max: 1500 },
      { key: "actual", label: "What actually happened", type: "textarea", max: 1500 },
      { key: "browser", label: "Browser", type: "text", max: 120 },
      { key: "os", label: "Operating system", type: "text", max: 120 },
      { key: "device", label: "Device", type: "text", max: 120 },
      { key: "screen", label: "Screen size", type: "text", max: 40 },
      { key: "consoleErrors", label: "Error message", type: "textarea", max: 4000, hint: "If an error appeared on screen, paste it here.", wide: true },
    ],
  },
  partnership: {
    descriptionLabel: "Your message",
    descriptionPlaceholder: "Tell us about your business and what you have in mind.",
    fields: [
      { key: "company", label: "Company", type: "text", required: true, max: 160 },
      { key: "contactPerson", label: "Contact person", type: "text", max: 120 },
      { key: "businessEmail", label: "Business email", type: "email", required: true, max: 255 },
      { key: "phone", label: "Business phone", type: "text", max: 20 },
      {
        key: "partnershipType",
        label: "Partnership type",
        type: "select",
        max: 60,
        options: [
          { value: "", label: "Choose one" },
          { value: "Brand partnership", label: "Brand partnership" },
          { value: "Wholesale", label: "Wholesale" },
          { value: "Vendor / supplier", label: "Vendor / supplier" },
          { value: "Affiliate", label: "Affiliate" },
          { value: "Advertising", label: "Advertising" },
          { value: "Other", label: "Other" },
        ],
      },
      { key: "website", label: "Website", type: "url", max: 300, placeholder: "https://…" },
    ],
  },
  feature: {
    descriptionLabel: "Describe the idea",
    descriptionPlaceholder: "What would you like to be able to do?",
    fields: [
      { key: "featureTitle", label: "Feature", type: "text", required: true, max: 160, placeholder: "A short name for it", wide: true },
      { key: "useCase", label: "How would you use it?", type: "textarea", max: 2000 },
      { key: "whyNeeded", label: "Why does it matter to you?", type: "textarea", max: 2000 },
      {
        key: "customerImpact",
        label: "How often would you use it?",
        type: "select",
        max: 60,
        options: [
          { value: "", label: "Choose one" },
          { value: "Every visit", label: "Every visit" },
          { value: "Often", label: "Often" },
          { value: "Now and then", label: "Now and then" },
        ],
      },
    ],
  },
  feedback: {
    descriptionLabel: "Your feedback",
    descriptionPlaceholder: "What's on your mind? We read every message.",
    fields: [
      {
        key: "rating",
        label: "Overall, how are we doing?",
        type: "select",
        max: 2,
        options: [
          { value: "", label: "Choose one" },
          { value: "5", label: "★★★★★ Excellent" },
          { value: "4", label: "★★★★ Good" },
          { value: "3", label: "★★★ Okay" },
          { value: "2", label: "★★ Poor" },
          { value: "1", label: "★ Very poor" },
        ],
      },
    ],
  },
  general: {
    descriptionLabel: "How can we help?",
    descriptionPlaceholder: "Tell us as much as you can and we'll take it from there.",
    fields: [],
  },
};

/** The form for a category, falling back to the general one. */
export function formFor(name: string | undefined): FormSpec {
  return FORMS[(name ?? "general") as SupportForm] ?? FORMS.general;
}

/**
 * What the browser can tell us about itself, to prefill a bug report. The
 * customer can correct any of it; nothing is sent until they submit.
 */
export function detectEnvironment(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /OPR\//.test(agent)
      ? "Opera"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Firefox\//.test(agent)
          ? "Firefox"
          : /Safari\//.test(agent)
            ? "Safari"
            : "";
  const os = /Windows/.test(agent)
    ? "Windows"
    : /Android/.test(agent)
      ? "Android"
      : /iPhone|iPad|iPod/.test(agent)
        ? "iOS"
        : /Mac OS X/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : "";
  const device = /Mobi|Android|iPhone/.test(agent) ? "Phone" : /iPad|Tablet/.test(agent) ? "Tablet" : "Computer";
  return {
    browser,
    os,
    device,
    screen: `${window.screen.width}×${window.screen.height}`,
    pageUrl: document.referrer && new URL(document.referrer).origin === window.location.origin ? document.referrer : "",
  };
}
