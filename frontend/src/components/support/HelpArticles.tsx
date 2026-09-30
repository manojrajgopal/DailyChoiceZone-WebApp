"use client";

import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, ChevronDown, Loader2, Search, ThumbsDown, ThumbsUp } from "lucide-react";

import { getArticle, rateArticle, searchArticles, type HelpArticle } from "@/services/supportService";

import { Modal } from "@/components/ui/Dialog";
import { cn } from "@/lib/utils/cn";

/** An article's text: paragraphs separated by blank lines. */
function ArticleBody({ body }: { body: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink-700">
      {body
        .split(/\n{2,}/)
        .filter((paragraph) => paragraph.trim())
        .map((paragraph, index) => (
          <p key={index} className="whitespace-pre-line">
            {paragraph}
          </p>
        ))}
    </div>
  );
}

/** The full article, fetched when first opened (which is what counts a view). */
function useArticleBody(article: HelpArticle, open: boolean) {
  const [body, setBody] = useState<string | null>(article.body ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || body !== null) return;
    let active = true;
    getArticle(article.slug)
      .then((full) => active && setBody(full.body ?? ""))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [open, body, article.slug]);
  return { body, failed };
}

/**
 * "Before you write to us": help articles for the issue the customer picked,
 * each ending "Did this solve your problem?". A yes ends the journey happily;
 * a no carries on to the form. Both answers are counted for the store.
 */
export function ArticleSuggestions({
  articles,
  onSolved,
  onNeedHelp,
}: {
  articles: HelpArticle[];
  onSolved: () => void;
  onNeedHelp: () => void;
}) {
  const [openId, setOpenId] = useState<number | null>(articles[0]?.id ?? null);

  return (
    <div>
      <ul className="flex flex-col gap-3">
        {articles.map((article) => (
          <li key={article.id}>
            <SuggestedArticle
              article={article}
              open={openId === article.id}
              onToggle={() => setOpenId((current) => (current === article.id ? null : article.id))}
              onSolved={onSolved}
              onNotSolved={onNeedHelp}
            />
          </li>
        ))}
      </ul>

      <div className="mt-6 flex flex-col items-start gap-3 rounded-card bg-cream-deep p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink-700">Didn&rsquo;t find your answer?</p>
        <button
          type="button"
          onClick={onNeedHelp}
          className="inline-flex h-11 items-center justify-center rounded-control bg-ink px-6 label-wide text-cream transition-colors hover:bg-ink-700"
        >
          Contact support
        </button>
      </div>
    </div>
  );
}

function SuggestedArticle({
  article,
  open,
  onToggle,
  onSolved,
  onNotSolved,
}: {
  article: HelpArticle;
  open: boolean;
  onToggle: () => void;
  onSolved: () => void;
  onNotSolved: () => void;
}) {
  const { body, failed } = useArticleBody(article, open);
  const [answered, setAnswered] = useState(false);
  const panelId = useId();

  const answer = (helpful: boolean) => {
    if (!answered) void rateArticle(article.id, helpful).catch(() => undefined);
    setAnswered(true);
    if (helpful) onSolved();
    else onNotSolved();
  };

  return (
    <div className={cn("rounded-card border bg-shell transition-colors", open ? "border-ink" : "border-ink-200")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-start gap-3 p-4 text-left"
      >
        <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">{article.title}</span>
          {article.summary ? <span className="mt-0.5 block text-xs text-ink-500">{article.summary}</span> : null}
        </span>
        <ChevronDown
          className={cn("mt-0.5 h-4 w-4 shrink-0 text-ink-400 transition-transform", open && "rotate-180")}
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div id={panelId} className="border-t border-ink-100 px-4 pb-4 pt-3.5">
          {body === null && !failed ? (
            <p className="flex items-center gap-2 text-sm text-ink-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
            </p>
          ) : failed ? (
            <p className="text-sm text-ink-500">{article.summary || "We couldn't load this article."}</p>
          ) : (
            <ArticleBody body={body ?? ""} />
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-4">
            <p className="mr-2 text-sm font-medium text-ink">Did this solve your problem?</p>
            <button
              type="button"
              onClick={() => answer(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-pill border border-ink-200 px-3.5 text-sm text-ink-700 transition-colors hover:border-sage-600 hover:text-sage-600"
            >
              <ThumbsUp className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Yes, solved
            </button>
            <button
              type="button"
              onClick={() => answer(false)}
              className="inline-flex h-9 items-center gap-1.5 rounded-pill border border-ink-200 px-3.5 text-sm text-ink-700 transition-colors hover:border-ink hover:text-ink"
            >
              <ThumbsDown className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              No, contact support
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Search the help articles from the top of the contact page. */
export function ArticleSearch() {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<HelpArticle[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [openArticle, setOpenArticle] = useState<HelpArticle | null>(null);
  const listId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  // Results only for a search of three letters or more.
  const shown = term.trim().length >= 3 ? results : null;

  useEffect(() => {
    const text = term.trim();
    if (text.length < 3) return;
    let active = true;
    const timer = setTimeout(() => {
      setLoading(true);
      searchArticles(text)
        .then((found) => active && setResults(found))
        .catch(() => active && setResults([]))
        .finally(() => setLoading(false));
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [term]);

  // Close the results when focus or a click leaves the search.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setResults(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div ref={wrapper} className="relative">
      <Search
        className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-400"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <label htmlFor={`${listId}-input`} className="sr-only">
        Search help articles
      </label>
      <input
        id={`${listId}-input`}
        type="search"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setResults(null);
        }}
        placeholder="Search for answers — e.g. refund, cancel order, UPI"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={shown !== null}
        autoComplete="off"
        className="h-14 w-full rounded-card border border-ink-200 bg-shell pl-12 pr-4 text-[0.9375rem] text-ink shadow-[0_1px_0_rgba(30,27,24,0.04)] placeholder:text-ink-400 hover:border-ink-300 focus:border-copper-500"
      />
      {loading ? (
        <Loader2 className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-ink-400" aria-hidden="true" />
      ) : null}

      {shown !== null ? (
        <div
          id={listId}
          className="absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-card border border-ink-200 bg-shell shadow-overlay"
        >
          {shown.length === 0 ? (
            <p className="px-4 py-4 text-sm text-ink-500">
              No articles match &ldquo;{term.trim()}&rdquo;. Choose a topic below and we&rsquo;ll help directly.
            </p>
          ) : (
            <ul>
              {shown.map((article) => (
                <li key={article.id} className="border-b border-ink-100 last:border-0">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenArticle(article);
                      setResults(null);
                    }}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-cream-deep"
                  >
                    <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">{article.title}</span>
                      <span className="block truncate text-xs text-ink-500">{article.summary}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {openArticle ? <ArticleModal article={openArticle} onClose={() => setOpenArticle(null)} /> : null}
    </div>
  );
}

function ArticleModal({ article, onClose }: { article: HelpArticle; onClose: () => void }) {
  const { body, failed } = useArticleBody(article, true);
  const [answered, setAnswered] = useState<boolean | null>(null);
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={article.title} description={article.summary} className="max-w-xl">
      {body === null && !failed ? (
        <p className="flex items-center gap-2 text-sm text-ink-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
        </p>
      ) : (
        <ArticleBody body={failed ? article.summary : (body ?? "")} />
      )}
      <div className="mt-6 border-t border-ink-100 pt-4">
        {answered === null ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-2 text-sm font-medium text-ink">Was this helpful?</p>
            {[true, false].map((helpful) => (
              <button
                key={String(helpful)}
                type="button"
                onClick={() => {
                  void rateArticle(article.id, helpful).catch(() => undefined);
                  setAnswered(helpful);
                }}
                className="inline-flex h-9 items-center gap-1.5 rounded-pill border border-ink-200 px-3.5 text-sm text-ink-700 transition-colors hover:border-ink hover:text-ink"
              >
                {helpful ? (
                  <ThumbsUp className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <ThumbsDown className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                )}
                {helpful ? "Yes" : "No"}
              </button>
            ))}
          </div>
        ) : answered ? (
          <p className="text-sm text-ink-700" role="status">
            Glad it helped!
          </p>
        ) : (
          <p className="text-sm text-ink-700" role="status">
            Sorry about that — choose a topic below and we&rsquo;ll help you directly.
          </p>
        )}
      </div>
    </Modal>
  );
}
