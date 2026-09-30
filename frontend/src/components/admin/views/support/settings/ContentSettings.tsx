"use client";

import { useState } from "react";
import { Eye, Loader2 } from "lucide-react";

import {
  previewEmailTemplate,
  reason,
  saveEmailTemplate,
  type CannedReply,
  type EmailTemplate,
  type HelpArticle,
  type SupportCategory,
} from "@/services/supportService";

import { AdminButton, AdminCard } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminSelect, AdminTextarea, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { Modal } from "@/components/ui/Dialog";
import { formatAgo } from "@/lib/support/format";
import { toast } from "@/store/toastStore";

import { ActiveBadge, AddButton, ConfigTable, DeleteButton, EditButton, EditModal, saveRow, type TabProps } from "./shared";

/** Every category and option as "Payments › UPI Issue", for pickers. */
function flatten(nodes: SupportCategory[], prefix = ""): { id: number; label: string; level: number }[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: prefix + node.name, level: node.level },
    ...flatten(node.children, `${prefix}${node.name} › `),
  ]);
}

/* ------------------------------------------------------------------ articles */

type ArticleDraft = { title: string; slug: string; summary: string; body: string; categoryIds: number[]; keywords: string; active: boolean; sortOrder: number };

export function ArticleSettings({ config, reload }: TabProps) {
  const [editing, setEditing] = useState<HelpArticle | "new" | null>(null);
  const [draft, setDraft] = useState<ArticleDraft | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("");
  const options = flatten(config.categories).filter((entry) => entry.label.toLowerCase().includes(categoryFilter.trim().toLowerCase()));
  const labels = new Map(flatten(config.categories).map((entry) => [entry.id, entry.label]));

  const open = (article: HelpArticle | "new") => {
    setDraft(
      article === "new"
        ? { title: "", slug: "", summary: "", body: "", categoryIds: [], keywords: "", active: true, sortOrder: config.articles.length }
        : {
            title: article.title,
            slug: article.slug,
            summary: article.summary,
            body: article.body ?? "",
            categoryIds: article.categoryIds,
            keywords: article.keywords,
            active: article.active,
            sortOrder: article.sortOrder,
          },
    );
    setCategoryFilter("");
    setEditing(article);
  };

  return (
    <AdminCard
      title="Help articles"
      description="Offered on the contact page before a customer writes in, for the categories each article is linked to."
      action={<AddButton onClick={() => open("new")}>Add article</AddButton>}
      padded={false}
    >
      <ConfigTable
        minWidth="44rem"
        headers={[{ label: "Article" }, { label: "Shown for" }, { label: "Views", align: "right" }, { label: "Helpful", align: "right" }, { label: "Status" }, { label: "", align: "right" }]}
        empty={config.articles.length === 0 ? "No articles yet." : undefined}
      >
        {config.articles.map((article) => {
          const votes = article.helpful + article.notHelpful;
          return (
            <tr key={article.id} className="hover:bg-admin-raised">
              <td className="max-w-[18rem] px-3 py-2.5">
                <p className="font-medium text-admin-ink">{article.title}</p>
                <p className="truncate text-admin-muted">{article.summary}</p>
              </td>
              <td className="max-w-[16rem] px-3 py-2.5 text-admin-muted">
                {article.categoryIds.length === 0 ? "Search only" : article.categoryIds.map((id) => labels.get(id) ?? "?").join(", ")}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">{article.views}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{votes ? `${Math.round((100 * article.helpful) / votes)}% of ${votes}` : "—"}</td>
              <td className="px-3 py-2.5">
                <ActiveBadge active={article.active} />
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right">
                <EditButton name={article.title} onClick={() => open(article)} />
                <DeleteButton list="articles" id={article.id} name={article.title} reload={reload} />
              </td>
            </tr>
          );
        })}
      </ConfigTable>

      {draft ? (
        <EditModal
          open={editing !== null}
          onOpenChange={(next) => !next && setEditing(null)}
          title={editing === "new" ? "Add a help article" : `Edit ${draft.title}`}
          wide
          onSave={() => saveRow("articles", draft, editing === "new" || editing === null ? null : editing.id, reload, "Article")}
        >
          <FormGrid columns={2}>
            <AdminInput label="Title" required value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <AdminInput
              label="Address"
              value={draft.slug}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
              hint="Made from the title if left blank."
            />
          </FormGrid>
          <AdminInput label="Summary" value={draft.summary} maxLength={300} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} hint="One line, shown in search results." />
          <AdminTextarea
            label="Article"
            required
            rows={8}
            maxLength={20000}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            hint="Plain text. Leave a blank line between paragraphs."
          />
          <AdminInput
            label="Keywords"
            value={draft.keywords}
            maxLength={300}
            onChange={(e) => setDraft({ ...draft, keywords: e.target.value })}
            hint="Words customers might search for, separated by spaces."
          />
          <fieldset className="rounded-[3px] border border-admin-border p-3">
            <legend className="px-1 text-xs font-medium text-admin-ink">Shown for these topics</legend>
            <input
              type="search"
              aria-label="Filter topics"
              placeholder="Filter issues…"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="mb-2 h-8 w-full rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs"
            />
            <div className="scroll-panel grid max-h-56 gap-0.5 overflow-y-auto sm:grid-cols-2">
              {options.map((entry) => (
                <AdminCheckbox
                  key={entry.id}
                  label={entry.label}
                  checked={draft.categoryIds.includes(entry.id)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      categoryIds: event.target.checked ? [...draft.categoryIds, entry.id] : draft.categoryIds.filter((id) => id !== entry.id),
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
          <AdminToggle label="Published" checked={draft.active} onChange={(active) => setDraft({ ...draft, active })} />
        </EditModal>
      ) : null}
    </AdminCard>
  );
}

/* ------------------------------------------------------------ saved replies */

export function CannedSettings({ config, reload }: TabProps) {
  const [editing, setEditing] = useState<CannedReply | "new" | null>(null);
  const [draft, setDraft] = useState({ title: "", body: "", categoryId: "", active: true });
  const topics = flatten(config.categories).filter((entry) => entry.level === 1);

  return (
    <AdminCard
      title="Saved replies"
      description="Starting points agents insert into a reply and edit before sending."
      action={
        <AddButton
          onClick={() => {
            setDraft({ title: "", body: "", categoryId: "", active: true });
            setEditing("new");
          }}
        >
          Add reply
        </AddButton>
      }
      padded={false}
    >
      <ConfigTable
        minWidth="36rem"
        headers={[{ label: "Reply" }, { label: "Topic" }, { label: "Status" }, { label: "", align: "right" }]}
        empty={config.canned.length === 0 ? "No saved replies yet." : undefined}
      >
        {config.canned.map((row) => (
          <tr key={row.id} className="hover:bg-admin-raised">
            <td className="max-w-[26rem] px-3 py-2.5">
              <p className="font-medium text-admin-ink">{row.title}</p>
              <p className="truncate text-admin-muted">{row.body}</p>
            </td>
            <td className="px-3 py-2.5 text-admin-muted">{topics.find((topic) => topic.id === row.categoryId)?.label ?? "Any"}</td>
            <td className="px-3 py-2.5">
              <ActiveBadge active={row.active} />
            </td>
            <td className="whitespace-nowrap px-3 py-2.5 text-right">
              <EditButton
                name={row.title}
                onClick={() => {
                  setDraft({ title: row.title, body: row.body, categoryId: row.categoryId ? String(row.categoryId) : "", active: row.active });
                  setEditing(row);
                }}
              />
              <DeleteButton list="canned" id={row.id} name={row.title} reload={reload} />
            </td>
          </tr>
        ))}
      </ConfigTable>

      <EditModal
        open={editing !== null}
        onOpenChange={(next) => !next && setEditing(null)}
        title={editing === "new" ? "Add a saved reply" : `Edit ${draft.title}`}
        onSave={() =>
          saveRow(
            "canned",
            { ...draft, categoryId: draft.categoryId ? Number(draft.categoryId) : null },
            editing === "new" || editing === null ? null : editing.id,
            reload,
            "Reply",
          )
        }
      >
        <AdminInput label="Title" required value={draft.title} maxLength={120} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <AdminTextarea label="Reply" required rows={6} maxLength={5000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        <AdminSelect
          label="Topic"
          value={draft.categoryId}
          onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}
          placeholder="Any topic"
          options={topics.map((topic) => ({ value: String(topic.id), label: topic.label }))}
        />
        <AdminToggle label="Active" checked={draft.active} onChange={(active) => setDraft({ ...draft, active })} />
      </EditModal>
    </AdminCard>
  );
}

/* ----------------------------------------------------------------- templates */

export function TemplateSettings({ config, reload }: TabProps) {
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [draft, setDraft] = useState({ subject: "", body: "", enabled: true });
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const insert = (variable: string) => {
    const token = `{{${variable}}}`;
    const element = document.getElementById("template-body") as HTMLTextAreaElement | null;
    if (!element) {
      setDraft((current) => ({ ...current, body: current.body + token }));
      return;
    }
    const start = element.selectionStart ?? draft.body.length;
    const end = element.selectionEnd ?? draft.body.length;
    setDraft((current) => ({ ...current, body: current.body.slice(0, start) + token + current.body.slice(end) }));
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const groups: [string, string, EmailTemplate[]][] = [
    ["customer", "To customers", config.templates.filter((row) => row.audience === "customer")],
    ["internal", "To your team", config.templates.filter((row) => row.audience === "internal")],
  ];

  return (
    <div className="flex flex-col gap-4">
      {groups.map(([key, title, rows]) => (
        <AdminCard
          key={key}
          title={title}
          description={
            key === "internal"
              ? "Sent to the people routing picks — the assigned agent, their team, the team's leads or the admins. No address is written in a template."
              : "Sent to the customer who raised the request."
          }
          padded={false}
        >
          <ConfigTable minWidth="36rem" headers={[{ label: "Email" }, { label: "Subject" }, { label: "Status" }, { label: "", align: "right" }]}>
            {rows.map((row) => (
              <tr key={row.key} className="hover:bg-admin-raised">
                <td className="px-3 py-2.5">
                  <p className="font-medium text-admin-ink">{row.label}</p>
                  <p className="text-admin-faint">Edited {formatAgo(row.updatedAt)}</p>
                </td>
                <td className="max-w-[22rem] truncate px-3 py-2.5 text-admin-muted">{row.subject}</td>
                <td className="px-3 py-2.5">
                  <StatusBadge tone={row.enabled ? "good" : "neutral"}>{row.enabled ? "Sending" : "Off"}</StatusBadge>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <EditButton
                    name={row.label}
                    onClick={() => {
                      setDraft({ subject: row.subject, body: row.body, enabled: row.enabled });
                      setEditing(row);
                    }}
                  />
                </td>
              </tr>
            ))}
          </ConfigTable>
        </AdminCard>
      ))}

      {editing ? (
        <EditModal
          open
          onOpenChange={(next) => !next && setEditing(null)}
          title={`Edit “${editing.label}”`}
          description={editing.audience === "internal" ? "Sent to your team." : "Sent to the customer."}
          wide
          onSave={async () => {
            try {
              await saveEmailTemplate(editing.key, draft);
              toast.success("Template saved.");
              await reload();
              return null;
            } catch (cause) {
              return reason(cause, "The template couldn't be saved.");
            }
          }}
        >
          <AdminInput label="Subject" required value={draft.subject} maxLength={200} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          <div>
            <label htmlFor="template-body" className="text-xs font-medium text-admin-ink">
              Email
            </label>
            <textarea
              id="template-body"
              rows={10}
              value={draft.body}
              maxLength={10000}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              className="mt-1.5 w-full rounded-[3px] border border-admin-border bg-admin-surface px-2.5 py-2 font-mono text-xs leading-relaxed text-admin-ink focus:border-copper-500"
            />
            <p className="mt-1.5 text-[0.6875rem] text-admin-muted">Insert a value — it&rsquo;s filled in for each request, safely escaped:</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {config.variables.map((variable) => (
                <button
                  key={variable}
                  type="button"
                  onClick={() => insert(variable)}
                  className="rounded-[3px] border border-admin-border bg-admin-raised px-1.5 py-0.5 font-mono text-[0.625rem] text-admin-ink hover:border-copper-500"
                >
                  {`{{${variable}}}`}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <AdminToggle label="Send this email" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
            <AdminButton
              size="sm"
              loading={previewing}
              onClick={async () => {
                setPreviewing(true);
                try {
                  setPreview(await previewEmailTemplate(draft.subject, draft.body));
                } catch (cause) {
                  toast.error(reason(cause));
                } finally {
                  setPreviewing(false);
                }
              }}
            >
              {!previewing ? <Eye className="h-3.5 w-3.5" aria-hidden="true" /> : null}
              Preview
            </AdminButton>
          </div>
        </EditModal>
      ) : null}

      <Modal open={preview !== null} onOpenChange={(next) => !next && setPreview(null)} title={preview?.subject ?? "Preview"} description="With sample values." className="max-w-2xl">
        {preview ? (
          // Sandboxed: the preview can render its layout but run nothing.
          <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-[60dvh] w-full rounded-[3px] border border-admin-border bg-white" />
        ) : (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        )}
      </Modal>
    </div>
  );
}
