"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { MessageCircleQuestion } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { useCustomerStatus } from "@/hooks/useSession";
import { formatDate } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import {
  askQuestion,
  getMyQuestions,
  getQuestions,
  type ProductQuestion,
} from "@/services/engagementService";
import { toast } from "@/store/toastStore";

const MAX = 500;
const PAGE_SIZE = 5;

/**
 * Questions and answers on the product page.
 *
 * Only questions a moderator has approved are listed (answered ones first),
 * and only published answers. A signed-in shopper also sees their own
 * questions still waiting for review, so asking never feels like shouting
 * into a void. Everything is rendered as text.
 */
export function ProductQuestions({ productId, productName }: { productId: string; productName: string }) {
  const { isSignedIn, isPending } = useCustomerStatus();
  const [items, setItems] = useState<ProductQuestion[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [mine, setMine] = useState<ProductQuestion[]>([]);
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (next: number) => {
      setLoading(true);
      setFailed(false);
      try {
        const data = await getQuestions(productId, next, PAGE_SIZE);
        setItems((current) => (next === 1 ? data.items : [...current, ...data.items]));
        setTotal(data.pagination.total);
        setPage(next);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [productId],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  useEffect(() => {
    if (isPending || !isSignedIn) return;
    getMyQuestions(productId)
      .then((rows) => setMine(rows.filter((row) => row.status !== "approved")))
      .catch(() => setMine([]));
  }, [isPending, isSignedIn, productId]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length < 10) {
      setError("Please write at least 10 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const question = await askQuestion(productId, trimmed);
      setMine((current) => [question, ...current]);
      setText("");
      setAsking(false);
      toast.success("Thanks! Your question will appear once our team has reviewed it.");
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "We couldn't send your question. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-ink-500">
          {total > 0 ? `${total} ${total === 1 ? "question" : "questions"} about ${productName}` : `No questions about ${productName} yet.`}
        </p>
        {isSignedIn ? (
          !asking ? (
            <Button variant="outline" size="sm" onClick={() => setAsking(true)}>
              <MessageCircleQuestion className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
              Ask a question
            </Button>
          ) : null
        ) : !isPending ? (
          <Link href={`/account?next=${encodeURIComponent(`/product/${productId}#questions`)}`}
            className="text-sm text-ink-700 underline underline-offset-4 hover:text-copper-700">
            Sign in to ask a question
          </Link>
        ) : null}
      </div>

      {asking ? (
        <form onSubmit={submit} className="flex max-w-2xl flex-col gap-3 rounded-card border border-ink-200 bg-shell p-5">
          <Textarea
            label="Your question"
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, MAX))}
            hint={`${text.length}/${MAX} · Questions are checked before they appear. Please don't include personal details or links.`}
            error={error ?? undefined}
            rows={3}
            required
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>{busy ? "Sending…" : "Submit question"}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setAsking(false); setError(null); }}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {mine.length > 0 ? (
        <div className="flex max-w-3xl flex-col gap-2">
          <p className="label-wide text-ink-500">Your questions</p>
          {mine.map((question) => (
            <div key={question.id} className="rounded-card border border-dashed border-ink-200 p-4">
              <p className="whitespace-pre-line text-sm text-ink">{question.question}</p>
              <p className="mt-1.5 text-xs text-ink-500">
                {question.status === "rejected"
                  ? `Not published${question.rejectionReason ? ` — ${question.rejectionReason}` : ""}.`
                  : "Waiting for review — we'll email you when it's answered."}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {failed && items.length === 0 ? (
        <div>
          <p className="text-sm text-ink-500">The questions didn&rsquo;t load.</p>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => void load(1)}>Try again</Button>
        </div>
      ) : (
        <ul className="flex max-w-3xl flex-col divide-y divide-ink-100">
          {items.map((question) => (
            <li key={question.id} className="py-5 first:pt-0">
              <p className="flex gap-2 text-sm text-ink">
                <span className="font-medium text-ink-500" aria-hidden="true">Q.</span>
                <span className="whitespace-pre-line">{question.question}</span>
              </p>
              <p className="mt-1 pl-6 text-xs text-ink-400">
                {question.author} · {formatDate(question.askedAt)}
                {question.size || question.color ? ` · ${[question.size, question.color].filter(Boolean).join(", ")}` : ""}
              </p>
              {question.answer ? (
                <div className="mt-3 flex gap-2 pl-0">
                  <span className="text-sm font-medium text-copper-700" aria-hidden="true">A.</span>
                  <div>
                    <p className="whitespace-pre-line text-sm leading-relaxed text-ink-700">{question.answer.body}</p>
                    <p className="mt-1 text-xs text-ink-400">
                      {question.answer.by}
                      {question.answer.answeredAt ? ` · ${formatDate(question.answer.answeredAt)}` : ""}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="mt-2 pl-6 text-xs text-ink-500">Not answered yet — our team will reply soon.</p>
              )}
            </li>
          ))}
          {loading && items.length === 0
            ? [0, 1].map((index) => (
                <li key={index} className="py-5">
                  <span className="block h-3 w-2/3 animate-pulse rounded bg-ink-100" />
                  <span className="mt-3 block h-3 w-1/2 animate-pulse rounded bg-ink-100" />
                </li>
              ))
            : null}
        </ul>
      )}

      {items.length < total ? (
        <div>
          <Button variant="outline" size="sm" onClick={() => void load(page + 1)} disabled={loading}>
            {loading ? "Loading…" : "Show more questions"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
