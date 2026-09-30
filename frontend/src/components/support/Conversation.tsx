"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Check, CheckCheck, Lock, Loader2, SendHorizontal } from "lucide-react";

import type { TicketMessage } from "@/services/supportService";

import { cn } from "@/lib/utils/cn";
import { dayKey, dayLabel, formatDateTime, formatTime } from "@/lib/support/format";

import { AttachmentChip, AttachmentPicker, type FileLimits } from "./SupportParts";

/**
 * A ticket's conversation, for either side.
 *
 * The customer's thread never contains internal notes — the API leaves them
 * out — so there is nothing here to hide; `audience` only decides which side
 * of the thread is "mine" and how authors are named.
 */
export function ConversationThread({
  messages,
  audience,
  variant,
  typing,
  attachmentScope,
  fetchLink,
  className,
}: {
  messages: TicketMessage[];
  audience: "customer" | "staff";
  variant: "store" | "admin";
  /** "Anil is typing…", or null. */
  typing?: string | null;
  attachmentScope: string;
  fetchLink: (id: number) => Promise<{ url: string }>;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastId = messages[messages.length - 1]?.id;

  // Follow new messages — unless the reader has scrolled up to read history.
  useEffect(() => {
    const element = scroller.current;
    if (element && nearBottom.current) element.scrollTop = element.scrollHeight;
  }, [lastId, typing]);

  const admin = variant === "admin";
  const mine = (message: TicketMessage) =>
    audience === "customer" ? message.kind === "customer" : message.kind === "agent" || message.kind === "note";

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
      className={cn("scroll-panel overflow-y-auto overscroll-contain", className)}
    >
      <ol role="log" aria-live="polite" aria-label="Conversation" className="flex flex-col gap-3 p-3 sm:p-4">
        {messages.map((message, index) => {
          const newDay = index === 0 || dayKey(messages[index - 1]?.createdAt) !== dayKey(message.createdAt);
          const divider = newDay ? (
            <li className="my-1 flex items-center gap-3" aria-hidden="true">
              <span className={cn("h-px flex-1", admin ? "bg-admin-border" : "bg-ink-200")} />
              <span className={cn("text-[0.6875rem]", admin ? "text-admin-faint" : "text-ink-400")}>
                {dayLabel(message.createdAt)}
              </span>
              <span className={cn("h-px flex-1", admin ? "bg-admin-border" : "bg-ink-200")} />
            </li>
          ) : null;

          if (message.kind === "system") {
            return (
              <Fragment key={message.id}>
                {divider}
                <li className="flex justify-center">
                  <p
                    className={cn(
                      "max-w-[90%] px-3 py-1 text-center text-[0.6875rem] leading-relaxed",
                      admin ? "rounded-[3px] bg-admin-raised text-admin-muted" : "rounded-pill bg-cream-deep text-ink-500",
                    )}
                  >
                    {message.body}
                    <span className="sr-only">, {formatDateTime(message.createdAt)}</span>
                  </p>
                </li>
              </Fragment>
            );
          }

          const own = mine(message);
          const note = message.kind === "note";

          return (
            <Fragment key={message.id}>
              {divider}
              <li className={cn("flex flex-col", own ? "items-end" : "items-start")}>
                <p className={cn("mb-1 flex items-center gap-1.5 px-1 text-[0.6875rem]", admin ? "text-admin-muted" : "text-ink-500")}>
                  {note ? <Lock className="h-3 w-3 text-[#8a5d00]" strokeWidth={2} aria-hidden="true" /> : null}
                  <span className="font-medium">{message.author || (message.kind === "agent" ? "Support team" : "Customer")}</span>
                  {note ? <span className="font-medium text-[#8a5d00]">Internal note · not visible to the customer</span> : null}
                  {audience === "staff" && message.kind === "customer" ? <span>· Customer</span> : null}
                </p>

                <div
                  className={cn(
                    "max-w-[min(34rem,88%)] px-3.5 py-2.5 text-sm leading-relaxed",
                    admin ? "rounded-[3px]" : "rounded-[0.875rem]",
                    note
                      ? "border border-[#fab219]/50 bg-[#fdf6e3] text-admin-ink"
                      : own
                        ? admin
                          ? "bg-copper-600 text-white"
                          : "rounded-br-[0.25rem] bg-ink text-cream"
                        : admin
                          ? "border border-admin-border bg-admin-surface text-admin-ink"
                          : "rounded-bl-[0.25rem] border border-ink-200 bg-shell text-ink",
                  )}
                >
                  {message.body ? <p className="whitespace-pre-wrap break-words">{message.body}</p> : null}
                  {message.attachments.length > 0 ? (
                    <div className={cn("flex flex-wrap gap-2", message.body && "mt-2")}>
                      {message.attachments.map((attachment) => (
                        <AttachmentChip
                          key={attachment.id}
                          attachment={attachment}
                          scope={attachmentScope}
                          fetchLink={fetchLink}
                          variant={variant}
                          onDark={own && !note && !admin}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>

                <p className={cn("mt-1 flex items-center gap-1 px-1 text-[0.625rem]", admin ? "text-admin-faint" : "text-ink-400")}>
                  <time dateTime={message.createdAt} title={formatDateTime(message.createdAt)}>
                    {formatTime(message.createdAt)}
                  </time>
                  {own && !note ? (
                    message.readAt ? (
                      <span className="inline-flex items-center gap-0.5">
                        <CheckCheck className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                        Seen
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-0.5">
                        <Check className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                        Sent
                      </span>
                    )
                  ) : null}
                </p>
              </li>
            </Fragment>
          );
        })}

        {typing ? (
          <li className="flex items-center gap-2 px-1" aria-live="polite">
            <span className="flex gap-1" aria-hidden="true">
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className={cn("h-1.5 w-1.5 animate-bounce rounded-pill", admin ? "bg-admin-faint" : "bg-ink-300")}
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </span>
            <span className={cn("text-xs", admin ? "text-admin-muted" : "text-ink-500")}>{typing}</span>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

/* ---------------------------------------------------------------- composer */

export interface ComposerSendExtra {
  internal: boolean;
  status?: string;
}

/**
 * Writing a message: text, files, and — for staff — an internal note, a
 * saved reply to start from, and a status to set as it goes.
 */
export function Composer({
  variant,
  limits,
  attachmentsEnabled,
  onSend,
  onTyping,
  allowInternal = false,
  statuses = [],
  canned = [],
  placeholder = "Write a message…",
  enterToSend = false,
  disabled = false,
}: {
  variant: "store" | "admin";
  limits: FileLimits;
  attachmentsEnabled: boolean;
  /** Resolve true when sent, so the composer clears. */
  onSend: (body: string, files: File[], extra: ComposerSendExtra) => Promise<boolean>;
  onTyping?: () => void;
  allowInternal?: boolean;
  /** Staff: statuses the ticket may move to as the reply goes. */
  statuses?: { value: string; label: string }[];
  canned?: { id: number; title: string; body: string }[];
  placeholder?: string;
  /** Chat: Enter sends and Shift+Enter starts a new line. */
  enterToSend?: boolean;
  disabled?: boolean;
}) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [internal, setInternal] = useState(false);
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);
  const lastTyping = useRef(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const boxId = useId();
  const admin = variant === "admin";

  // Grow with the text, to a point.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [body]);

  const send = async () => {
    if (sending || disabled || (!body.trim() && files.length === 0)) return;
    setSending(true);
    const sent = await onSend(body.trim(), files, { internal, status: internal ? undefined : status || undefined });
    setSending(false);
    if (sent) {
      setBody("");
      setFiles([]);
      setStatus("");
      box.current?.focus();
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className={cn(
        admin
          ? cn("border-t border-admin-border", internal ? "bg-[#fdf6e3]" : "bg-admin-surface")
          : "border-t border-ink-200 bg-shell",
      )}
    >
      {allowInternal ? (
        <div className="flex flex-wrap items-center gap-1 border-b border-admin-border px-3 pt-2" role="tablist" aria-label="Message type">
          {[
            { value: false, label: "Reply to customer" },
            { value: true, label: "Internal note" },
          ].map((tab) => (
            <button
              key={tab.label}
              type="button"
              role="tab"
              aria-selected={internal === tab.value}
              onClick={() => setInternal(tab.value)}
              className={cn(
                "-mb-px border-b-2 px-2.5 pb-2 text-xs font-medium transition-colors",
                internal === tab.value
                  ? tab.value
                    ? "border-[#b07500] text-[#8a5d00]"
                    : "border-copper-600 text-admin-ink"
                  : "border-transparent text-admin-muted hover:text-admin-ink",
              )}
            >
              {tab.value ? <Lock className="mr-1 inline h-3 w-3" strokeWidth={2} aria-hidden="true" /> : null}
              {tab.label}
            </button>
          ))}

          {canned.length > 0 && !internal ? (
            <select
              aria-label="Insert a saved reply"
              value=""
              onChange={(event) => {
                const chosen = canned.find((entry) => String(entry.id) === event.target.value);
                if (chosen) setBody((current) => (current ? `${current}\n\n${chosen.body}` : chosen.body));
              }}
              className="mb-1.5 ml-auto h-7 max-w-[12rem] cursor-pointer rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink"
            >
              <option value="">Saved replies…</option>
              {canned.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-1.5 p-2.5 sm:p-3">
        {attachmentsEnabled ? (
          <AttachmentPicker files={files} onChange={setFiles} limits={limits} variant={variant} compact disabled={disabled || sending} />
        ) : null}

        <label className="sr-only" htmlFor={boxId}>
          {internal ? "Internal note" : "Message"}
        </label>
        <textarea
          id={boxId}
          ref={box}
          rows={1}
          value={body}
          disabled={disabled}
          maxLength={admin ? 10000 : 5000}
          placeholder={internal ? "Only your team will see this note…" : placeholder}
          onChange={(event) => {
            setBody(event.target.value);
            const now = Date.now();
            if (onTyping && !internal && now - lastTyping.current > 4000) {
              lastTyping.current = now;
              onTyping();
            }
          }}
          onKeyDown={(event) => {
            const submit = enterToSend ? !event.shiftKey : event.metaKey || event.ctrlKey;
            if (event.key === "Enter" && submit) {
              event.preventDefault();
              void send();
            }
          }}
          className={cn(
            "min-h-10 min-w-0 flex-1 resize-none px-3 py-2 text-sm leading-relaxed outline-none transition-colors disabled:cursor-not-allowed",
            admin
              ? "rounded-[3px] border border-admin-border bg-admin-surface text-admin-ink placeholder:text-admin-faint focus:border-copper-500"
              : "rounded-[1.25rem] border border-ink-200 bg-cream text-ink placeholder:text-ink-400 focus:border-copper-500",
          )}
        />

        {statuses.length > 0 && !internal ? (
          <select
            aria-label="Set status when sending"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="h-10 max-w-[11rem] cursor-pointer rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink"
          >
            <option value="">Keep status</option>
            {statuses.map((entry) => (
              <option key={entry.value} value={entry.value}>
                Send &amp; mark {entry.label.toLowerCase()}
              </option>
            ))}
          </select>
        ) : null}

        <button
          type="submit"
          disabled={disabled || sending || (!body.trim() && files.length === 0)}
          className={cn(
            "inline-flex h-10 shrink-0 items-center justify-center gap-2 px-4 text-xs font-medium transition-colors disabled:cursor-not-allowed",
            admin
              ? internal
                ? "rounded-[3px] bg-[#b07500] text-white hover:bg-[#8a5d00] disabled:opacity-40"
                : "rounded-[3px] bg-copper-600 text-white hover:bg-copper-700 disabled:bg-copper-300"
              : "rounded-pill bg-ink uppercase tracking-[0.14em] text-cream hover:bg-ink-700 disabled:bg-ink-300",
          )}
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <SendHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          )}
          <span className={cn(!admin && "sr-only sm:not-sr-only")}>{internal ? "Add note" : "Send"}</span>
        </button>
      </div>
      <p className={cn("px-3 pb-2 text-[0.625rem]", admin ? "text-admin-faint" : "text-ink-400")}>
        {enterToSend ? "Enter to send · Shift+Enter for a new line" : "Ctrl+Enter to send"}
      </p>
    </form>
  );
}
