"use client";

import Link from "next/link";
import { useState } from "react";
import { RefreshCw, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminTextarea, AdminToggle } from "@/components/admin/ui/AdminForm";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { FilterSelect, LogFooter, LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { Badge, Detail, TD, TH, TableState, problem } from "@/components/admin/views/operations/shared";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import {
  answerQuestion,
  approveQuestion,
  deleteQuestion,
  editQuestion,
  getQuestion,
  listQuestions,
  rejectQuestion,
  type AdminQuestion,
} from "@/services/admin/engagementAdminService";
import { toast } from "@/store/toastStore";

const KEYS = ["status", "answered", "q", "product", "customer", "text"] as const;

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  pending: { label: "Awaiting review", tone: "amber" },
  approved: { label: "Published", tone: "green" },
  rejected: { label: "Declined", tone: "red" },
};

const ACTIONS: Record<string, string> = {
  asked: "Asked", approved: "Published", rejected: "Declined", answered: "Answer published",
  "answer-drafted": "Answer drafted", "answer-edited": "Answer edited", "answer-unpublished": "Answer unpublished",
  edited: "Question edited",
};

/**
 * Customer questions about products. Nothing appears on a product page until
 * it is published here; customers are emailed when their question is
 * published, declined or answered (unless they've turned those emails off).
 *
 * A question, its product and its customer are found by ID (docs/id-lookup.md),
 * each matched exactly; the text box searches only the question's own words,
 * never a product's or a customer's name.
 */
export function AdminQuestionsView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const [openId, setOpenId] = useState<number | null>(null);

  const list = useAdminResource(
    () => listQuestions({
      status: filters.status, answered: filters.answered, q: filters.q, productId: filters.product,
      customerId: filters.customer, text: filters.text, page, pageSize,
    }),
    [filters, page, pageSize],
  );
  const data = list.data;
  const counts = data?.counts ?? {};
  const filtered = Boolean(
    filters.status || filters.answered || filters.q || filters.product || filters.customer || filters.text,
  );

  return (
    <div>
      <AdminPageHeader
        title="Product questions"
        description="Review what customers ask, publish the useful ones, and answer them on the product page."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Questions" }]}
        actions={
          <AdminButton size="sm" onClick={() => void list.reload()} loading={list.isRefreshing}>
            {list.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
            Refresh
          </AdminButton>
        }
      />

      <StatusTabs
        label="Filter questions"
        value={filters.status}
        onChange={(status) => setFilters({ status })}
        tabs={[
          { value: "", label: "All" },
          { value: "pending", label: "Awaiting review", count: counts.pending },
          { value: "approved", label: "Published", count: counts.approved },
          { value: "rejected", label: "Declined", count: counts.rejected },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <LogSearch label="Words in the question" value={filters.text} onChange={(text) => setFilters({ text })} placeholder="Words in the question" />
        <IdFilter entity="question" value={filters.q} onChange={(q) => setFilters({ q })} className="w-40" />
        <IdFilter entity="product" value={filters.product} onChange={(product) => setFilters({ product })} className="w-52" />
        <IdFilter entity="customer" value={filters.customer} onChange={(customer) => setFilters({ customer })} className="w-52" />
        <FilterSelect
          label="Answered"
          value={filters.answered}
          onChange={(answered) => setFilters({ answered })}
          options={[
            { value: "", label: "Answered or not" },
            { value: "no", label: `Unanswered${counts.unanswered ? ` (${counts.unanswered} published)` : ""}` },
            { value: "yes", label: "Answered" },
          ]}
        />
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        <div className="relative overflow-x-auto">
          <table className={cn("w-full min-w-[56rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Question</th>
                <th className={TH}>Product</th>
                <th className={TH}>Customer</th>
                <th className={TH}>Status</th>
                <th className={TH}>Answer</th>
                <th className={TH}>Asked</th>
                <th className={cn(TH, "text-right")}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={7}
                loading={list.isLoading && !data}
                failed={Boolean(list.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void list.reload()}
                title={filtered ? "No questions match" : "No questions yet"}
                hint={filtered ? "Try different words or IDs." : "Questions appear here when customers ask them."}
              />
              {data?.items.map((row) => {
                const status = STATUS[row.status] ?? STATUS.pending!;
                return (
                  <tr key={row.id} className="align-top hover:bg-admin-raised">
                    <td className={cn(TD, "max-w-[22rem]")}>
                      <span className="line-clamp-3 whitespace-pre-line text-admin-ink">{row.question}</span>
                    </td>
                    <td className={TD}>
                      {row.product ? (
                        <Link href={`/product/${row.product.id}`} target="_blank" className="text-admin-ink hover:text-copper-700">
                          {row.product.name}
                        </Link>
                      ) : "—"}
                    </td>
                    <td className={cn(TD, "text-admin-muted")}>{row.customer?.email ?? row.author}</td>
                    <td className={TD}><Badge tone={status.tone}>{status.label}</Badge></td>
                    <td className={cn(TD, "text-admin-muted")}>
                      {row.answer ? (row.answer.published ? "Published" : "Draft") : "—"}
                    </td>
                    <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(row.askedAt)}</td>
                    <td className={cn(TD, "text-right")}>
                      <AdminButton size="sm" variant="ghost" onClick={() => setOpenId(row.id)} aria-label={`Review question ${row.id}`}>
                        {row.status === "pending" ? "Review" : "Open"}
                      </AdminButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </AdminCard>

      {data ? (
        <LogFooter page={data.pagination.page} pageSize={pageSize} total={data.pagination.total}
          totalPages={data.pagination.total_pages} onPage={setPage} onPageSize={setPageSize} />
      ) : null}

      <QuestionDialog id={openId} onClose={() => setOpenId(null)} onChanged={() => void list.reload()} />
    </div>
  );
}

function QuestionDialog({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const detail = useAdminResource(() => getQuestion(id ?? 0), [id], { enabled: id !== null });
  const row = detail.data;

  return (
    <Modal open={id !== null} onOpenChange={(open) => !open && onClose()} title="Product question" className="max-w-2xl">
      {!row ? (
        <p className="text-sm text-ink-500">{detail.error ? problem(detail.error, "This question didn't load.") : "Loading…"}</p>
      ) : (
        <QuestionEditor
          key={`${row.id}-${row.status}-${row.answer?.updatedAt ?? ""}-${row.question}`}
          row={row}
          reload={detail.reload}
          onClose={onClose}
          onChanged={onChanged}
        />
      )}
    </Modal>
  );
}

function QuestionEditor({ row, reload, onClose, onChanged }: {
  row: AdminQuestion;
  reload: () => Promise<void>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [answer, setAnswer] = useState(row.answer?.body ?? "");
  const [publish, setPublish] = useState(row.answer ? row.answer.published || !row.answer.body : true);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [wording, setWording] = useState(row.question);
  const [busy, setBusy] = useState("");
  const [deleting, setDeleting] = useState(false);

  const run = async (label: string, action: () => Promise<AdminQuestion | void>, done: string) => {
    setBusy(label);
    try {
      await action();
      toast.success(done);
      await reload();
      onChanged();
    } catch (error) {
      toast.error(problem(error, "That didn't work. Please try again."));
    } finally {
      setBusy("");
    }
  };

  return (
        <div className="flex flex-col gap-5 text-xs">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label="Product">{row.product?.name ?? "—"}</Detail>
            <Detail label="Status"><Badge tone={(STATUS[row.status] ?? STATUS.pending!).tone}>{(STATUS[row.status] ?? STATUS.pending!).label}</Badge></Detail>
            <Detail label="Customer">{row.customer ? `${row.customer.name} · ${row.customer.email}` : row.author}</Detail>
            <Detail label="Asked">{formatDateTime(row.askedAt)}{row.size || row.color ? ` · ${[row.size, row.color].filter(Boolean).join(", ")}` : ""}</Detail>
          </dl>

          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">Question</h3>
              {!editing ? (
                <button type="button" className="text-xs text-admin-muted underline hover:text-admin-ink" onClick={() => setEditing(true)}>
                  Edit wording
                </button>
              ) : null}
            </div>
            {editing ? (
              <div className="flex flex-col gap-2">
                <AdminTextarea label="Question" value={wording} onChange={(e) => setWording(e.target.value)} rows={3} maxLength={500}
                  hint="Fix a typo or remove personal details. The change is kept in the history." />
                <div className="flex gap-2">
                  <AdminButton size="sm" variant="primary" loading={busy === "edit"}
                    onClick={() => void run("edit", () => editQuestion(row.id, wording), "Question updated.")}>Save wording</AdminButton>
                  <AdminButton size="sm" variant="ghost" onClick={() => { setEditing(false); setWording(row.question); }}>Cancel</AdminButton>
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-line rounded-[3px] border border-admin-border bg-admin-raised p-3 text-sm text-admin-ink">{row.question}</p>
            )}
          </section>

          {row.status !== "rejected" ? (
            <section className="flex flex-col gap-2">
              <AdminTextarea label="Answer" value={answer} onChange={(e) => setAnswer(e.target.value)} rows={4} maxLength={2000}
                hint="Shown on the product page with your name. Plain text." />
              <AdminToggle label="Publish the answer" checked={publish} onChange={setPublish}
                description={publish ? "Shown on the product page; the customer is emailed." : "Saved as a draft only."} />
              <div>
                <AdminButton variant="primary" loading={busy === "answer"} disabled={!answer.trim() || busy !== ""}
                  onClick={() => void run("answer", () => answerQuestion(row.id, answer, publish, true),
                    publish ? (row.status === "pending" ? "Question and answer published." : "Answer published.") : "Draft saved.")}>
                  {row.status === "pending" && publish ? "Publish question & answer" : publish ? "Save & publish answer" : "Save draft"}
                </AdminButton>
              </div>
            </section>
          ) : null}

          <section className="flex flex-col gap-2 border-t border-admin-border pt-4">
            <div className="flex flex-wrap gap-2">
              {row.status !== "approved" ? (
                <AdminButton loading={busy === "approve"} disabled={busy !== ""}
                  onClick={() => void run("approve", () => approveQuestion(row.id), "Question published.")}>
                  Publish without an answer
                </AdminButton>
              ) : null}
              <AdminButton variant="ghost" onClick={() => setDeleting(true)} disabled={busy !== ""}>Delete</AdminButton>
            </div>
            {row.status !== "rejected" ? (
              <div className="flex flex-wrap items-end gap-2">
                <AdminInput label="Reason for declining (sent to the customer)" value={reason} className="min-w-[16rem] flex-1"
                  onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Please contact support about your order" />
                <AdminButton loading={busy === "reject"} disabled={busy !== ""}
                  onClick={() => void run("reject", () => rejectQuestion(row.id, reason), "Question declined.")}>
                  Decline
                </AdminButton>
              </div>
            ) : (
              <p className="text-admin-muted">Declined{row.rejectionReason ? `: ${row.rejectionReason}` : "."}</p>
            )}
          </section>

          {row.events && row.events.length > 0 ? (
            <section>
              <h3 className="mb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">History</h3>
              <ol className="flex flex-col gap-1.5">
                {row.events.map((event, index) => (
                  <li key={index} className="border-l-2 border-admin-border pl-2.5">
                    <span className="font-medium text-admin-ink">{ACTIONS[event.action] ?? event.action}</span>
                    <span className="text-admin-muted"> · {formatDateTime(event.at)}{event.by ? ` · ${event.by}` : ""}</span>
                    {event.note ? <p className="text-admin-muted">{event.note}</p> : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title="Delete this question?"
            message="It's removed from the product page and the portal, with its answer. This can't be undone."
            confirmLabel="Delete question"
            loading={busy === "delete"}
            onConfirm={() =>
              void (async () => {
                setBusy("delete");
                try {
                  await deleteQuestion(row.id);
                  toast.success("Question deleted.");
                  setDeleting(false);
                  onClose();
                  onChanged();
                } catch (error) {
                  toast.error(problem(error, "The question wasn't deleted."));
                } finally {
                  setBusy("");
                }
              })()
            }
          />
        </div>
  );
}
