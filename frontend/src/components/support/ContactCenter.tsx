"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  MessageCircle,
  MessagesSquare,
  PartyPopper,
  UserRound,
} from "lucide-react";

import type { Order } from "@/types";

import {
  createTicket,
  findDuplicates,
  getHandlers,
  getSupportConfig,
  reason,
  searchArticles,
  startChat,
  type CustomerTicket,
  type HandlerChoice,
  type HelpArticle,
  type NewTicket,
  type SupportCategory,
  type SupportCentreConfig,
  type TicketRow,
} from "@/services/supportService";

import { ErrorState } from "@/components/common/States";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { useSession } from "@/hooks/useSession";
import { getOrders } from "@/services/orderService";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { detectEnvironment, formFor, type FieldSpec } from "@/lib/support/forms";
import { toast } from "@/store/toastStore";

import { ArticleSearch, ArticleSuggestions } from "./HelpArticles";
import { AttachmentPicker, CategoryIcon, CustomerStatusBadge } from "./SupportParts";

type Step = "topic" | "option" | "issue" | "help" | "form" | "solved" | "done";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The contact page: a support centre rather than a form.
 *
 * The customer narrows down what they need — a topic, then an option, then
 * (where the store has set them up) a specific issue. The tree, its routing
 * and which questions each branch asks are all configuration read from the
 * API, so the store reshapes this page without a release. Before the form,
 * help articles for that issue are offered; the form itself asks only what
 * is relevant to the issue chosen.
 */
export function ContactCenter() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, isSignedIn } = useSession();

  const [config, setConfig] = useState<SupportCentreConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [step, setStep] = useState<Step>("topic");
  const [category, setCategory] = useState<SupportCategory | null>(null);
  const [option, setOption] = useState<SupportCategory | null>(null);
  const [issue, setIssue] = useState<SupportCategory | null>(null);
  const [articles, setArticles] = useState<HelpArticle[] | null>(null);
  const [created, setCreated] = useState<{ ticket: CustomerTicket; key: string | null } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    getSupportConfig()
      .then((result) => active && setConfig(result))
      .catch(() => active && setLoadError(true));
    return () => {
      active = false;
    };
  }, [attempt]);
  const load = () => {
    setLoadError(false);
    setAttempt((value) => value + 1);
  };

  // `/contact?topic=orders` opens straight at a topic (the order page links here).
  const wantedTopic = params.get("topic");
  useEffect(() => {
    if (!config || !wantedTopic || category) return;
    const match = config.categories.find((node) => node.slug === wantedTopic);
    if (match) choose(match, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, wantedTopic]);

  // Keep keyboard and screen-reader users with the flow as it moves on.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [step]);

  const deepest = issue ?? option ?? category;

  /** Pick a node at a level; move to its children, or on to help and the form. */
  function choose(node: SupportCategory, level: 1 | 2 | 3) {
    if (level === 1) {
      setCategory(node);
      setOption(null);
      setIssue(null);
    } else if (level === 2) {
      setOption(node);
      setIssue(null);
    } else {
      setIssue(node);
    }
    if (node.children.length > 0) {
      setStep(level === 1 ? "option" : "issue");
      return;
    }
    // The end of the branch: offer help articles first, if there are any.
    // The chosen node and its ancestors, nearest first.
    const path = (level === 1 ? [node] : level === 2 ? [node, category] : [node, option, category])
      .filter((entry): entry is SupportCategory => entry !== null)
      .map((entry) => entry.id);
    setArticles(null);
    searchArticles("", path)
      .then((found) => {
        const relevant = found.filter((article) => article.categoryIds.some((id) => path.includes(id)));
        setArticles(relevant);
        setStep(relevant.length > 0 ? "help" : "form");
      })
      .catch(() => {
        setArticles([]);
        setStep("form");
      });
  }

  function back() {
    if (step === "form" && articles && articles.length > 0) setStep("help");
    else if ((step === "form" || step === "help") && issue) {
      setIssue(null);
      setStep("issue");
    } else if ((step === "form" || step === "help" || step === "issue") && option) {
      setOption(null);
      setIssue(null);
      setStep("option");
    } else {
      reset();
    }
  }

  function reset() {
    setCategory(null);
    setOption(null);
    setIssue(null);
    setArticles(null);
    setStep("topic");
  }

  if (loadError) {
    return <ErrorState title="The support centre didn't load" description="Please check your connection and try again." onRetry={load} />;
  }

  if (!config) {
    return (
      <div aria-busy="true" aria-label="Loading the support centre">
        <Skeleton className="h-14 w-full" />
        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const trail = [category, option, issue].filter((node): node is SupportCategory => node !== null);

  return (
    <div>
      {/* --------------------------------------------------------- the hero */}
      <div className="rounded-card bg-cream-deep px-4 py-6 sm:px-8 sm:py-8">
        <p className="label-wide text-copper-700">Help centre</p>
        <h2 className="mt-2 font-display text-2xl leading-tight text-ink sm:text-[1.75rem]">What can we help you with?</h2>
        <div className="mt-5 max-w-2xl">
          <ArticleSearch />
        </div>
        <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-600">
          <li className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
            {config.open ? "We're open now" : "We're closed right now"} · {config.hours}
          </li>
          <li className="flex items-center gap-1.5">
            <MessagesSquare className="h-3.5 w-3.5 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
            {config.chat.available ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-pill bg-sage-600" aria-hidden="true" />
                Live chat available
              </span>
            ) : (
              "Live chat offline"
            )}
          </li>
          {isSignedIn ? (
            <li>
              <Link href="/account/support" className="font-medium text-copper-700 underline underline-offset-2 hover:text-ink">
                Your support requests
              </Link>
            </li>
          ) : null}
        </ul>
      </div>

      {/* --------------------------------------------------------- the flow */}
      <section className="mt-8" aria-labelledby="contact-step-heading">
        {trail.length > 0 && step !== "done" && step !== "solved" ? (
          <nav aria-label="Your choices" className="mb-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={back}
              className="inline-flex items-center gap-1.5 rounded-pill border border-ink-200 px-3 py-1.5 text-xs text-ink-700 transition-colors hover:border-ink hover:text-ink"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
              Back
            </button>
            <ol className="flex flex-wrap items-center gap-1 text-sm text-ink-500">
              <li>
                <button type="button" onClick={reset} className="hover:text-ink hover:underline">
                  All topics
                </button>
              </li>
              {trail.map((node, index) => (
                <li key={node.id} className="flex items-center gap-1">
                  <ChevronRight className="h-3.5 w-3.5 text-ink-300" aria-hidden="true" />
                  {index < trail.length - 1 ? (
                    <button
                      type="button"
                      onClick={() => choose(node, (index + 1) as 1 | 2)}
                      className="hover:text-ink hover:underline"
                    >
                      {node.name}
                    </button>
                  ) : (
                    <span className="font-medium text-ink" aria-current="step">
                      {node.name}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}

        {step === "topic" ? (
          <>
            <StepHeading ref={heading} title="Choose a topic" subtitle="Pick the one closest to what you need — we'll narrow it down from there." />
            <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {config.categories.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => choose(node, 1)}
                    className="group flex h-full w-full flex-col items-start rounded-card border border-ink-200 bg-shell p-4 text-left transition-colors hover:border-ink focus-visible:border-ink"
                  >
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-pill bg-cream-deep text-copper-700 transition-colors group-hover:bg-ink group-hover:text-cream">
                      <CategoryIcon name={node.icon} className="h-5 w-5" />
                    </span>
                    <span className="mt-3 font-display text-base text-ink">{node.name}</span>
                    {node.description ? (
                      <span className="mt-1 text-xs leading-relaxed text-ink-500">{node.description}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {step === "option" && category ? (
          <ChoiceList
            headingRef={heading}
            title={`${category.name}: what's it about?`}
            nodes={category.children}
            onChoose={(node) => choose(node, 2)}
          />
        ) : null}

        {step === "issue" && option ? (
          <ChoiceList
            headingRef={heading}
            title={`${option.name}: which fits best?`}
            nodes={option.children}
            onChoose={(node) => choose(node, 3)}
          />
        ) : null}

        {step === "help" && articles ? (
          <>
            <StepHeading
              ref={heading}
              title="These might answer it straight away"
              subtitle="Most questions about this are answered here. If not, we're a click away."
            />
            <ArticleSuggestions articles={articles} onSolved={() => setStep("solved")} onNeedHelp={() => setStep("form")} />
          </>
        ) : null}

        {step === "solved" ? (
          <div className="rounded-card border border-ink-200 bg-shell px-6 py-12 text-center" role="status">
            <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-pill bg-sage-100">
              <PartyPopper className="h-6 w-6 text-sage-600" strokeWidth={1.5} aria-hidden="true" />
            </span>
            <h2 ref={heading} tabIndex={-1} className="mt-4 font-display text-xl text-ink outline-none">
              Glad that sorted it
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-ink-500">Thanks for letting us know. Anything else we can help with?</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button variant="outline" onClick={reset}>
                Back to help topics
              </Button>
              <Button variant="ghost" onClick={() => setStep("form")}>
                I still need help
              </Button>
            </div>
          </div>
        ) : null}

        {step === "form" && category && deepest ? (
          <RequestForm
            key={deepest.id}
            headingRef={heading}
            config={config}
            category={category}
            option={option}
            issue={issue}
            deepest={deepest}
            signedIn={isSignedIn}
            customerName={user ? `${user.firstName} ${user.lastName}`.trim() : ""}
            customerEmail={user?.email ?? ""}
            onCreated={(result) => {
              setCreated(result);
              setStep("done");
            }}
            onChat={(result) => {
              const number = encodeURIComponent(result.ticket.number);
              router.push(
                result.key
                  ? `/support/ticket?number=${number}&key=${encodeURIComponent(result.key)}`
                  : `/account/ticket?number=${number}`,
              );
            }}
          />
        ) : null}

        {step === "done" && created ? (
          <Confirmation headingRef={heading} config={config} created={created} onAnother={reset} />
        ) : null}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ parts */

function StepHeading({
  ref,
  title,
  subtitle,
}: {
  ref: React.Ref<HTMLHeadingElement>;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-5">
      <h2 id="contact-step-heading" ref={ref} tabIndex={-1} className="font-display text-xl text-ink outline-none sm:text-2xl">
        {title}
      </h2>
      {subtitle ? <p className="mt-1.5 text-sm text-ink-500">{subtitle}</p> : null}
    </div>
  );
}

function ChoiceList({
  headingRef,
  title,
  nodes,
  onChoose,
}: {
  headingRef: React.Ref<HTMLHeadingElement>;
  title: string;
  nodes: SupportCategory[];
  onChoose: (node: SupportCategory) => void;
}) {
  return (
    <>
      <StepHeading ref={headingRef} title={title} />
      <ul className="grid gap-2 sm:grid-cols-2">
        {nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              onClick={() => onChoose(node)}
              className="group flex w-full items-center justify-between gap-3 rounded-card border border-ink-200 bg-shell px-4 py-3.5 text-left transition-colors hover:border-ink focus-visible:border-ink"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{node.name}</span>
                {node.description ? <span className="mt-0.5 block text-xs text-ink-500">{node.description}</span> : null}
              </span>
              <ArrowRight
                className="h-4 w-4 shrink-0 text-ink-400 transition-transform group-hover:translate-x-0.5 group-hover:text-ink"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/* ------------------------------------------------------------------ form */

function RequestForm({
  headingRef,
  config,
  category,
  option,
  issue,
  deepest,
  signedIn,
  customerName,
  customerEmail,
  onCreated,
  onChat,
}: {
  headingRef: React.Ref<HTMLHeadingElement>;
  config: SupportCentreConfig;
  category: SupportCategory;
  option: SupportCategory | null;
  issue: SupportCategory | null;
  deepest: SupportCategory;
  signedIn: boolean;
  customerName: string;
  customerEmail: string;
  onCreated: (result: { ticket: CustomerTicket; key: string | null }) => void;
  onChat: (result: { ticket: CustomerTicket; key: string | null }) => void;
}) {
  const params = useSearchParams();
  const spec = formFor(deepest.resolved.form);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  // A bug report starts with what the browser can tell about itself.
  const [details, setDetails] = useState<Record<string, string>>(() =>
    deepest.resolved.form === "bug" ? detectEnvironment() : {},
  );
  const [files, setFiles] = useState<File[]>([]);
  const [orderId, setOrderId] = useState(params.get("order") ?? "");
  const [productId, setProductId] = useState("");
  const [handler, setHandler] = useState<{ teamId: number | null; agentId: number | null }>({ teamId: null, agentId: null });
  const [honeypot, setHoneypot] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<"ticket" | "chat" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [orders, setOrders] = useState<Order[] | null>(null);
  const [duplicates, setDuplicates] = useState<TicketRow[]>([]);
  const [handlers, setHandlers] = useState<HandlerChoice | null>(null);

  useEffect(() => {
    if (!signedIn || !spec.order) return;
    let active = true;
    getOrders()
      .then((list) => active && setOrders(list))
      .catch(() => active && setOrders([]));
    return () => {
      active = false;
    };
  }, [signedIn, spec.order]);

  // An open request about the same thing — worth continuing instead.
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    findDuplicates({ categoryId: category.id, subcategoryId: option?.id ?? null, issueId: issue?.id ?? null, orderId: orderId || null })
      .then((found) => active && setDuplicates(found))
      .catch(() => active && setDuplicates([]));
    return () => {
      active = false;
    };
  }, [signedIn, category.id, option?.id, issue?.id, orderId]);

  useEffect(() => {
    if (deepest.resolved.customerChoice !== "team" && deepest.resolved.customerChoice !== "agent") return;
    let active = true;
    getHandlers(deepest.id)
      .then((choice) => active && setHandlers(choice))
      .catch(() => active && setHandlers(null));
    return () => {
      active = false;
    };
  }, [deepest.id, deepest.resolved.customerChoice]);

  const chosenOrder = useMemo(() => orders?.find((order) => order.id === orderId) ?? null, [orders, orderId]);
  const target = config.responseTargets[deepest.resolved.priority];

  const setDetail = (key: string, value: string) => {
    setDetails((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" }));
  };

  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {};
    if (!signedIn) {
      if (name.trim().length < 2) next.name = "Enter your name.";
      if (!EMAIL.test(email.trim())) next.email = "Enter a valid email address so we can reply.";
      if (phone.trim() && !/^[6-9]\d{9}$/.test(phone.replace(/\D/g, "").slice(-10))) {
        next.phone = "Enter a 10-digit mobile number, or leave it blank.";
      }
    }
    if (spec.order === "required" && !orderId && !details.orderNumber?.trim()) next.order = "Choose the order this is about.";
    for (const field of spec.fields) {
      const value = (details[field.key] ?? "").trim();
      if (field.required && !value) next[field.key] = `${field.label} is required.`;
      else if (value && field.type === "email" && !EMAIL.test(value)) next[field.key] = "Enter a valid email address.";
      else if (value && field.type === "url" && !/^https?:\/\/\S+$/i.test(value)) next[field.key] = "Enter a full web address (https://…).";
    }
    if (description.trim().length < 10) next.description = "Please tell us a little more (at least 10 characters).";
    return next;
  };

  const payload = (): NewTicket => {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(details)) if (value?.trim()) cleaned[key] = value.trim();
    if (chosenOrder) cleaned.orderNumber = chosenOrder.orderNumber;
    const product = chosenOrder?.lines.find((line) => line.productId === productId);
    if (product && !cleaned.productName) cleaned.productName = product.name;
    return {
      categoryId: category.id,
      subcategoryId: option?.id ?? null,
      issueId: issue?.id ?? null,
      subject: subject.trim() || undefined,
      description: description.trim(),
      details: cleaned,
      orderId: orderId || null,
      productId: productId || null,
      teamId: handler.agentId ? null : handler.teamId,
      agentId: handler.agentId,
      name: signedIn ? undefined : name.trim(),
      email: signedIn ? undefined : email.trim(),
      phone: phone.trim() || undefined,
      website: honeypot,
    };
  };

  const submit = async (mode: "ticket" | "chat") => {
    const next = validate();
    setErrors(next);
    setFormError(null);
    if (Object.values(next).some(Boolean)) {
      setFormError("Please check the highlighted fields.");
      // Move focus to the first problem so it is heard and seen.
      requestAnimationFrame(() => {
        (document.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus();
      });
      return;
    }
    setSending(mode);
    try {
      if (mode === "chat") {
        const result = await startChat(payload(), files);
        onChat(result);
      } else {
        const result = await createTicket(payload(), files);
        onCreated(result);
      }
    } catch (cause) {
      const message = reason(cause, "We couldn't send your request. Please try again.");
      setFormError(message);
      toast.error(message);
    } finally {
      setSending(null);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit("ticket");
      }}
    >
      <StepHeading
        ref={headingRef}
        title="Tell us what's happened"
        subtitle={
          target
            ? `We usually reply within ${target} ${target === 1 ? "hour" : "hours"} for requests like this.`
            : "We'll get back to you as soon as we can."
        }
      />

      {duplicates.length > 0 ? (
        <div className="mb-6 rounded-card border border-copper-200 bg-copper-50 p-4" role="note">
          <p className="text-sm font-medium text-ink">You already have an open request about this</p>
          <p className="mt-0.5 text-xs text-ink-600">Replying there keeps everything in one conversation and is usually faster.</p>
          <ul className="mt-3 flex flex-col gap-2">
            {duplicates.map((ticket) => (
              <li key={ticket.id}>
                <Link
                  href={`/account/ticket?number=${encodeURIComponent(ticket.number)}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-ink-200 bg-shell px-3 py-2.5 text-sm transition-colors hover:border-ink"
                >
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{ticket.number}</span>
                    <span className="text-ink-500"> · {ticket.subject}</span>
                  </span>
                  <CustomerStatusBadge status={ticket.status} label={ticket.statusLabel} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="flex flex-col gap-7">
          {/* ------------------------------------------------ who's asking */}
          {signedIn ? (
            <p className="flex items-center gap-2 rounded-card bg-cream-deep px-3.5 py-2.5 text-sm text-ink-700">
              <UserRound className="h-4 w-4 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
              Sending as <span className="font-medium">{customerName || customerEmail}</span>
              <span className="text-ink-400">·</span>
              <span className="truncate text-ink-500">{customerEmail}</span>
            </p>
          ) : (
            <fieldset>
              <legend className="label-wide mb-3 text-ink">Your details</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input label="Your name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} required />
                <Input
                  label="Email address"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  error={errors.email}
                  hint="Replies and a link to your request go here."
                  required
                />
                <Input
                  label="Mobile number"
                  type="tel"
                  autoComplete="tel"
                  inputMode="numeric"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  error={errors.phone}
                  hint="Optional"
                />
              </div>
              <p className="mt-3 text-xs text-ink-500">
                Have an account?{" "}
                <Link href="/account" className="text-copper-700 underline underline-offset-2 hover:text-ink">
                  Sign in
                </Link>{" "}
                to link this to your orders and follow it from your account.
              </p>
            </fieldset>
          )}

          {/* ---------------------------------------------- what it's about */}
          {spec.order ? (
            <fieldset>
              <legend className="label-wide mb-3 text-ink">Which order?</legend>
              {signedIn ? (
                orders === null ? (
                  <Skeleton className="h-11 w-full" />
                ) : orders.length === 0 ? (
                  <Input
                    label="Order number"
                    value={details.orderNumber ?? ""}
                    onChange={(e) => setDetail("orderNumber", e.target.value)}
                    hint="We couldn't find orders on your account — type the number if you have one."
                    error={errors.order}
                  />
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Select
                      label="Order"
                      value={orderId}
                      onChange={(e) => {
                        setOrderId(e.target.value);
                        setProductId("");
                        setErrors((current) => ({ ...current, order: "" }));
                      }}
                      error={errors.order}
                      options={[
                        { value: "", label: spec.order === "required" ? "Choose an order" : "Not about a specific order" },
                        ...orders.map((order) => ({
                          value: order.id,
                          label: `${order.orderNumber} · ${formatDate(order.placedAt)} · ${order.lines.length} ${order.lines.length === 1 ? "item" : "items"}`,
                        })),
                      ]}
                    />
                    {spec.product && chosenOrder ? (
                      <Select
                        label="Which item?"
                        value={productId}
                        onChange={(e) => setProductId(e.target.value)}
                        options={[
                          { value: "", label: "Choose an item" },
                          ...chosenOrder.lines.map((line) => ({
                            value: line.productId,
                            label: `${line.name}${line.size ? ` · ${line.size}` : ""}${line.color ? ` · ${line.color}` : ""}`,
                          })),
                        ]}
                      />
                    ) : null}
                  </div>
                )
              ) : (
                <Input
                  label="Order number"
                  value={details.orderNumber ?? ""}
                  onChange={(e) => setDetail("orderNumber", e.target.value)}
                  placeholder="DCZ-4F8210"
                  hint="Optional — it's in your order confirmation email."
                  error={errors.order}
                  className="sm:max-w-xs"
                />
              )}
            </fieldset>
          ) : null}

          {/* ----------------------------------------- who handles it (opt.) */}
          {handlers && handlers.teams.length > 0 ? (
            <HandlerPicker choice={handlers} value={handler} onChange={setHandler} />
          ) : null}

          {/* ------------------------------------------------ issue fields */}
          {spec.fields.length > 0 ? (
            <fieldset>
              <legend className="label-wide mb-3 text-ink">A few details</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {spec.fields.map((field) => (
                  <DetailField
                    key={field.key}
                    field={field}
                    value={details[field.key] ?? ""}
                    error={errors[field.key]}
                    onChange={(value) => setDetail(field.key, value)}
                  />
                ))}
              </div>
            </fieldset>
          ) : null}

          {/* ------------------------------------------------- the message */}
          <fieldset className="flex flex-col gap-4">
            <legend className="label-wide mb-3 text-ink">Your message</legend>
            <Input
              label="Subject"
              value={subject}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={deepest.name}
              hint="Optional — we'll use the topic if you leave it blank."
            />
            <Textarea
              label={spec.descriptionLabel}
              rows={6}
              maxLength={5000}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setErrors((current) => ({ ...current, description: "" }));
              }}
              placeholder={spec.descriptionPlaceholder}
              error={errors.description}
              hint={`${description.trim().length}/5000`}
              required
            />
            {config.attachments.enabled ? (
              <div>
                <p className="label-wide mb-2 text-ink-700">Attachments</p>
                <AttachmentPicker files={files} onChange={setFiles} limits={config.attachments} hint={spec.attachmentHint} />
              </div>
            ) : (
              <p className="text-xs text-ink-500">
                File uploads aren&rsquo;t available right now — describe what you see, or paste a link to a screenshot.
              </p>
            )}
          </fieldset>

          {/* Invisible to people; only a form-filling bot fills it in. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
            <label>
              Website
              <input tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
            </label>
          </div>

          {formError ? (
            <p role="alert" className="rounded-card bg-danger-bg px-3.5 py-2.5 text-sm text-danger">
              {formError}
            </p>
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button type="submit" size="lg" disabled={sending !== null}>
              {sending === "ticket" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Send request
            </Button>
            {config.chat.available ? (
              <Button type="button" size="lg" variant="outline" disabled={sending !== null} onClick={() => void submit("chat")}>
                {sending === "chat" ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <MessageCircle className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
                )}
                Chat with us now
              </Button>
            ) : null}
          </div>
          <p className="-mt-3 text-xs text-ink-400">
            By sending this you agree to us using these details to answer your request.{" "}
            <Link href="/privacy" className="underline underline-offset-2 hover:text-ink">
              Privacy policy
            </Link>
          </p>
        </div>

        {/* ------------------------------------------------------- aside */}
        <aside className="flex flex-col gap-4 lg:pt-1">
          <div className="rounded-card border border-ink-200 bg-shell p-4">
            <p className="label-wide text-ink-400">Your request</p>
            <p className="mt-2 text-sm font-medium text-ink">{[category.name, option?.name, issue?.name].filter(Boolean).join(" › ")}</p>
            {target ? (
              <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-ink-600">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
                First reply usually within {target} {target === 1 ? "hour" : "hours"}.
              </p>
            ) : null}
          </div>
          <div className="rounded-card border border-ink-200 bg-shell p-4">
            <p className="label-wide text-ink-400">Live chat</p>
            {config.chat.available ? (
              <p className="mt-2 text-xs leading-relaxed text-ink-600">
                Someone is available now. Fill in the form and choose <span className="font-medium">Chat with us now</span> to talk
                straight away — the chat is saved as a request, so nothing gets lost.
              </p>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-ink-600">
                {config.chat.reason === "disabled"
                  ? "Live chat isn't offered at the moment."
                  : config.chat.reason === "closed"
                    ? `Chat is open ${config.hours}.`
                    : "Nobody is free to chat right now."}{" "}
                Send a request and we&rsquo;ll reply by email.
              </p>
            )}
          </div>
        </aside>
      </div>
    </form>
  );
}

function DetailField({
  field,
  value,
  error,
  onChange,
}: {
  field: FieldSpec;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const common = {
    label: field.label,
    error,
    hint: field.hint,
    required: field.required,
    className: field.wide || field.type === "textarea" ? "sm:col-span-2" : undefined,
  };
  if (field.type === "textarea") {
    return (
      <Textarea
        {...common}
        rows={field.max > 2000 ? 5 : 3}
        maxLength={field.max}
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.type === "select") {
    return <Select {...common} options={field.options ?? []} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <Input
      {...common}
      type={field.type === "number" ? "text" : field.type}
      inputMode={field.type === "number" ? "decimal" : undefined}
      max={field.type === "date" ? new Date().toISOString().slice(0, 10) : undefined}
      maxLength={field.max}
      value={value}
      placeholder={field.placeholder}
      onChange={(e) => onChange(field.type === "number" ? e.target.value.replace(/[^\d.]/g, "") : e.target.value)}
    />
  );
}

/**
 * Where the store lets the customer choose: a team, or a named person. The
 * customer picks a *person* — nobody's email address is ever shown, and the
 * system routes the request to them.
 */
function HandlerPicker({
  choice,
  value,
  onChange,
}: {
  choice: HandlerChoice;
  value: { teamId: number | null; agentId: number | null };
  onChange: (value: { teamId: number | null; agentId: number | null }) => void;
}) {
  const options: { key: string; teamId: number | null; agentId: number | null; title: string; detail: string; available?: boolean }[] = [
    { key: "auto", teamId: null, agentId: null, title: "Whoever is free first", detail: "Usually the fastest reply." },
  ];
  for (const team of choice.teams) {
    if (choice.choice === "team") {
      options.push({ key: `t${team.id}`, teamId: team.id, agentId: null, title: team.name, detail: team.description });
    } else {
      for (const agent of team.agents) {
        options.push({
          key: `a${agent.id}`,
          teamId: team.id,
          agentId: agent.id,
          title: agent.name,
          detail: [agent.role, agent.specialization, team.name].filter(Boolean).join(" · "),
          available: agent.available,
        });
      }
    }
  }
  if (options.length <= 1) return null;
  const selected = value.agentId ? `a${value.agentId}` : value.teamId ? `t${value.teamId}` : "auto";

  return (
    <fieldset>
      <legend className="label-wide mb-1 text-ink">Who should look at this?</legend>
      <p className="mb-3 text-xs text-ink-500">Optional. You can ask for a specialist, or leave it to us.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.key}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-card border bg-shell p-3.5 transition-colors",
              selected === option.key ? "border-ink bg-cream-deep" : "border-ink-200 hover:border-ink-300",
            )}
          >
            <input
              type="radio"
              name="handler"
              className="mt-1 accent-ink"
              checked={selected === option.key}
              onChange={() => onChange({ teamId: option.teamId, agentId: option.agentId })}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-medium text-ink">
                {option.title}
                {option.available !== undefined ? (
                  <span className={cn("text-[0.6875rem] font-normal", option.available ? "text-sage-600" : "text-ink-400")}>
                    {option.available ? "● Available" : "Away"}
                  </span>
                ) : null}
              </span>
              {option.detail ? <span className="mt-0.5 block text-xs text-ink-500">{option.detail}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Confirmation({
  headingRef,
  config,
  created,
  onAnother,
}: {
  headingRef: React.Ref<HTMLHeadingElement>;
  config: SupportCentreConfig;
  created: { ticket: CustomerTicket; key: string | null };
  onAnother: () => void;
}) {
  const { ticket, key } = created;
  const href = key
    ? `/support/ticket?number=${encodeURIComponent(ticket.number)}&key=${encodeURIComponent(key)}`
    : `/account/ticket?number=${encodeURIComponent(ticket.number)}`;
  const target = config.responseTargets[ticket.priority];

  return (
    <div className="rounded-card border border-ink-200 bg-shell px-5 py-10 text-center sm:px-10" role="status">
      <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-pill bg-sage-100">
        <CheckCircle2 className="h-7 w-7 text-sage-600" strokeWidth={1.5} aria-hidden="true" />
      </span>
      <h2 ref={headingRef} tabIndex={-1} className="mt-4 font-display text-2xl text-ink outline-none">
        We&rsquo;ve got your request
      </h2>
      <p className="mt-2 text-sm text-ink-500">
        Your reference is <span className="font-medium tabular-nums text-ink">{ticket.number}</span>. We&rsquo;ve emailed you a
        copy.
      </p>

      <dl className="mx-auto mt-6 grid max-w-md gap-3 rounded-card bg-cream-deep p-4 text-left text-sm sm:grid-cols-2">
        <div>
          <dt className="label-wide text-ink-400">With</dt>
          <dd className="mt-1 text-ink-700">{ticket.agentCard?.name ?? (ticket.teamName ? `${ticket.teamName} team` : "Our team")}</dd>
        </div>
        <div>
          <dt className="label-wide text-ink-400">Expect a reply</dt>
          <dd className="mt-1 text-ink-700">
            {ticket.responseDueAt ? `By ${formatDate(ticket.responseDueAt)}` : target ? `Within ${target} hours` : "Soon"}
          </dd>
        </div>
      </dl>

      <div className="mt-7 flex flex-wrap justify-center gap-3">
        <Link
          href={href}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-control bg-ink px-6 label-wide text-cream transition-colors hover:bg-ink-700"
        >
          View your request
          <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
        </Link>
        <Button variant="outline" onClick={onAnother}>
          Ask something else
        </Button>
      </div>
      {key ? (
        <p className="mx-auto mt-5 max-w-md text-xs text-ink-400">
          Keep the email we sent — its link is how you&rsquo;ll get back to this request without an account.
        </p>
      ) : null}
    </div>
  );
}
