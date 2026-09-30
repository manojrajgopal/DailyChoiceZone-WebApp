"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type {
  AccountNavItem,
  DeliveryMethod,
  FaqEntry,
  Labelled,
  PaymentMethodOption,
  SiteContent,
  SizeChart,
} from "@/types";

import { AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import {
  AdminInput,
  AdminTextarea,
  FormSection,
  TagListInput,
} from "@/components/admin/ui/AdminForm";
import { RecordListEditor } from "@/components/admin/ui/RecordListEditor";
import {
  SettingsLayout,
  SettingsSaveBar,
  changed,
  useSettingsSection,
  type SettingsSection,
} from "@/components/admin/ui/SettingsLayout";
import { useAdminResource } from "@/hooks/useAdminResource";
import { getContentDocument, saveContentDocument } from "@/services/admin/documentAdminService";
import { toast } from "@/store/toastStore";

/**
 * The content document: every list the two applications render.
 *
 * All of this used to be an array in a component — the states a delivery
 * address could name, the topics the contact form offered, the FAQ, the size
 * charts, the buckets on the filter panel, the vocabularies behind the
 * portal's own dropdowns. Changing any of it meant editing code and shipping a
 * build.
 *
 * One document and one Save, shown a section at a time: the
 * storefront reads it whole, and writing half of it would leave a page with
 * half a list.
 *
 * **The portal's own dropdowns are in here too**, which is worth pausing on.
 * Editing the roles list changes the labels somebody picks from; it does *not*
 * change what a role is allowed to do. That is `app/core/permissions.py` on
 * the server, deliberately out of reach — a list an administrator can edit
 * must never be the thing that decides what they may edit.
 */

const SECTION_IDS = ["states", "delivery", "payment", "searches", "sorting", "filters", "contact", "account", "faq", "sizes", "roles", "stock", "ranges", "home"];

export function AdminContentSettingsView() {
  const { data, isLoading, reload } = useAdminResource(() => getContentDocument(), []);

  const [draft, setDraft] = useState<SiteContent | null>(null);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useSettingsSection(SECTION_IDS);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  if (isLoading || !draft) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading content" />
      </div>
    );
  }

  const patch = <K extends keyof SiteContent>(key: K, value: SiteContent[K]) =>
    setDraft({ ...draft, [key]: value });

  const onSave = async () => {
    if ((draft.states ?? []).length === 0) {
      setSection("states");
      toast.error("Keep at least one state — checkout cannot collect an address without one.");
      return;
    }
    if ((draft.paymentMethods ?? []).length === 0) {
      setSection("payment");
      toast.error("Keep at least one payment method, or nobody can check out.");
      return;
    }

    setSaving(true);
    const result = await saveContentDocument(draft);
    setSaving(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success("Content saved");
    await reload();
  };

  const saved = data ?? draft;
  const sections: SettingsSection[] = [
    {
      id: "states",
      label: "Delivery states",
      group: "Checkout",
      count: (draft.states ?? []).length,
      dirty: changed(draft.states, saved.states),
      content: (
        <FormSection
          title="Delivery states"
          description="What a customer can choose as the state on an address. The tax treatment is decided from it."
        >
          <TagListInput
            label="States"
            values={draft.states ?? []}
            onChange={(states) => patch("states", states)}
            placeholder="Add a state and press Enter"
            hint="Shown in this order."
          />
        </FormSection>
      ),
    },
    {
      id: "delivery",
      label: "Delivery methods",
      group: "Checkout",
      count: (draft.deliveryMethods ?? []).length,
      dirty: changed(draft.deliveryMethods, saved.deliveryMethods),
      content: (
        <FormSection
          title="Delivery methods"
          description="The fee and estimate come from store settings, so the figure quoted is the one charged."
        >
          <RecordListEditor<DeliveryMethod>
            rows={draft.deliveryMethods ?? []}
            onChange={(deliveryMethods) => patch("deliveryMethods", deliveryMethods)}
            title={(row) => row.name || "New method"}
            addLabel="Add a delivery method"
            emptyMessage="No delivery methods. Checkout cannot be completed without one."
            blank={() => ({ id: "", name: "", description: "", fee: 0, estimate: "" })}
            fields={[
              { key: "id", label: "Identifier", hint: "A short internal code, lowercase with no spaces — for example, express." },
              { key: "name", label: "Name" },
              { key: "description", label: "Description", span: "full" },
            ]}
          />
        </FormSection>
      ),
    },
    {
      id: "payment",
      label: "Payment methods",
      group: "Checkout",
      count: (draft.paymentMethods ?? []).length,
      dirty: changed(draft.paymentMethods, saved.paymentMethods),
      content: (
        <FormSection
          title="Payment methods"
          description="Which are offered at checkout is set under Billing; this is what each one is called."
        >
          <RecordListEditor<PaymentMethodOption>
            rows={draft.paymentMethods ?? []}
            onChange={(paymentMethods) => patch("paymentMethods", paymentMethods)}
            title={(row) => row.name || "New method"}
            addLabel="Add a payment method"
            emptyMessage="No payment methods. Nobody can check out."
            blank={() => ({ id: "", name: "", label: "", description: "" })}
            fields={[
              { key: "id", label: "Identifier", hint: "Stored on the payment. Lower case, no spaces." },
              { key: "name", label: "Name at checkout" },
              { key: "label", label: "Short label", hint: "Used in tables and on invoices." },
              { key: "description", label: "Description" },
            ]}
          />
        </FormSection>
      ),
    },
    {
      id: "searches",
      label: "Popular searches",
      group: "Search & browsing",
      count: (draft.popularSearches ?? []).length,
      dirty: changed(draft.popularSearches, saved.popularSearches),
      content: (
        <FormSection
          title="Popular searches"
          description="Shown to shoppers when they open search."
        >
          <TagListInput
            label="Search terms"
            values={draft.popularSearches ?? []}
            onChange={(popularSearches) => patch("popularSearches", popularSearches)}
            placeholder="Add a term and press Enter"
          />
        </FormSection>
      ),
    },
    {
      id: "sorting",
      label: "Sort orders",
      group: "Search & browsing",
      count: (draft.sortOptions ?? []).length,
      dirty: changed(draft.sortOptions, saved.sortOptions),
      content: (
        <FormSection title="Sort orders" description="The options in the listing toolbar.">
          <RecordListEditor<Labelled>
            rows={draft.sortOptions ?? []}
            onChange={(sortOptions) => patch("sortOptions", sortOptions)}
            title={(row) => row.label || "New option"}
            addLabel="Add a sort order"
            blank={() => ({ value: "", label: "" })}
            fields={[
              {
                key: "value",
                label: "Value",
                hint: "Choose one of: recommended, newest, price-asc, price-desc, rating, popular, discount.",
              },
              { key: "label", label: "Label" },
            ]}
          />
        </FormSection>
      ),
    },
    {
      id: "filters",
      label: "Rating & discount filters",
      group: "Search & browsing",
      dirty: changed(draft.ratingFilters, saved.ratingFilters) || changed(draft.discountFilters, saved.discountFilters),
      content: (
        <FormSection
          title="Rating and discount filters"
          description="The rating and discount shortcuts on the filter panel."
        >
          <NumberListInput
            label="Minimum ratings"
            hint="Offered as “4★ & above”, and so on."
            values={draft.ratingFilters ?? []}
            onChange={(ratingFilters) => patch("ratingFilters", ratingFilters)}
          />
          <NumberListInput
            label="Minimum discounts"
            hint="Percentages, offered as “25% off or more”."
            values={draft.discountFilters ?? []}
            onChange={(discountFilters) => patch("discountFilters", discountFilters)}
          />
        </FormSection>
      ),
    },
    {
      id: "contact",
      label: "Contact form topics",
      group: "Customer pages",
      count: (draft.contactTopics ?? []).length,
      dirty: changed(draft.contactTopics, saved.contactTopics),
      content: (
        <FormSection
          title="Contact form topics"
          description="What the “What is it about?” field offers."
        >
          <RecordListEditor<Labelled>
            rows={draft.contactTopics ?? []}
            onChange={(contactTopics) => patch("contactTopics", contactTopics)}
            title={(row) => row.label || "New topic"}
            addLabel="Add a topic"
            blank={() => ({ value: "", label: "" })}
            fields={[
              { key: "value", label: "Value" },
              { key: "label", label: "Label" },
            ]}
          />
        </FormSection>
      ),
    },
    {
      id: "account",
      label: "Account menu",
      group: "Customer pages",
      count: (draft.accountNavigation ?? []).length,
      dirty: changed(draft.accountNavigation, saved.accountNavigation),
      content: (
        <FormSection title="Account menu" description="The sidebar on every account page.">
          <RecordListEditor<AccountNavItem>
            rows={draft.accountNavigation ?? []}
            onChange={(accountNavigation) => patch("accountNavigation", accountNavigation)}
            title={(row) => row.label || "New entry"}
            addLabel="Add an entry"
            blank={() => ({ href: "", label: "", icon: "user" })}
            fields={[
              { key: "label", label: "Label" },
              {
                key: "icon",
                label: "Icon",
                kind: "select",
                options: [
                  { value: "user", label: "Person" },
                  { value: "package", label: "Parcel" },
                  { value: "file-text", label: "Document" },
                  { value: "map-pin", label: "Map pin" },
                  { value: "heart", label: "Heart" },
                  { value: "settings", label: "Cog" },
                ],
              },
              { key: "href", label: "Path", span: "full" },
            ]}
          />
        </FormSection>
      ),
    },
    {
      id: "faq",
      label: "FAQ",
      group: "Customer pages",
      count: (draft.faqs ?? []).length,
      dirty: changed(draft.faqs, saved.faqs),
      content: (
        <FormSection
          title="Frequently asked questions"
          description="The accordion on the FAQ page, in this order."
        >
          <RecordListEditor<FaqEntry>
            rows={draft.faqs ?? []}
            onChange={(faqs) => patch("faqs", faqs)}
            title={(row) => row.question || "New question"}
            addLabel="Add a question"
            blank={() => ({ question: "", answer: "" })}
            fields={[
              { key: "question", label: "Question", span: "full" },
              { key: "answer", label: "Answer", kind: "textarea" },
            ]}
          />
        </FormSection>
      ),
    },
    {
      id: "sizes",
      label: "Size guide",
      group: "Customer pages",
      dirty: changed(draft.sizeGuide, saved.sizeGuide),
      content: (
        <FormSection
          title="Size guide"
          description="The charts under the FAQ. Each is a table with its own columns."
        >
          <AdminTextarea
            label="Introduction"
            rows={2}
            value={draft.sizeGuide?.intro ?? ""}
            onChange={(event) =>
              patch("sizeGuide", {
                intro: event.target.value,
                charts: draft.sizeGuide?.charts ?? [],
              })
            }
          />
          <SizeChartsEditor
            charts={draft.sizeGuide?.charts ?? []}
            onChange={(charts) =>
              patch("sizeGuide", { intro: draft.sizeGuide?.intro ?? "", charts })
            }
          />
        </FormSection>
      ),
    },
    {
      id: "roles",
      label: "Administrator roles",
      group: "Portal lists",
      count: (draft.adminRoles ?? []).length,
      dirty: changed(draft.adminRoles, saved.adminRoles),
      content: (
        <FormSection
          title="Administrator roles"
          description="The labels this portal offers. What each role can do is fixed and cannot be changed here."
        >
          <RecordListEditor<Labelled & { description: string }>
            rows={draft.adminRoles ?? []}
            onChange={(adminRoles) => patch("adminRoles", adminRoles)}
            title={(row) => row.label || "New role"}
            addLabel="Add a role"
            blank={() => ({ value: "", label: "", description: "" })}
            fields={[
              {
                key: "value",
                label: "Value",
                hint: "Must be one of: super-admin, admin, manager, editor, staff.",
              },
              { key: "label", label: "Label" },
              { key: "description", label: "Description", span: "full" },
            ]}
          />
        </FormSection>
      ),
    },
    {
      id: "stock",
      label: "Stock adjustment reasons",
      group: "Portal lists",
      count: (draft.stockAdjustmentReasons ?? []).length,
      dirty: changed(draft.stockAdjustmentReasons, saved.stockAdjustmentReasons),
      content: (
        <FormSection
          title="Stock adjustment reasons"
          description="Reasons staff can give when changing stock."
        >
          <RecordListEditor<Labelled>
            rows={draft.stockAdjustmentReasons ?? []}
            onChange={(stockAdjustmentReasons) =>
              patch("stockAdjustmentReasons", stockAdjustmentReasons)
            }
            title={(row) => row.label || "New reason"}
            addLabel="Add a reason"
            blank={() => ({ value: "", label: "" })}
            fields={[
              { key: "value", label: "Value" },
              { key: "label", label: "Label" },
            ]}
          />
        </FormSection>
      ),
    },
    {
      id: "ranges",
      label: "Report ranges",
      group: "Portal lists",
      count: (draft.analyticsRanges ?? []).length,
      dirty: changed(draft.analyticsRanges, saved.analyticsRanges),
      content: (
        <FormSection
          title="Report ranges"
          description="The periods the dashboard and reports can be read over."
        >
          <RecordListEditor<Labelled & { shortLabel: string }>
            rows={draft.analyticsRanges ?? []}
            onChange={(analyticsRanges) => patch("analyticsRanges", analyticsRanges)}
            title={(row) => row.label || "New range"}
            addLabel="Add a range"
            blank={() => ({ value: "", label: "", shortLabel: "" })}
            fields={[
              {
                key: "value",
                label: "Value",
                hint: "Choose one of: today, 7d, 30d, 3m, 1y.",
              },
              { key: "label", label: "Label" },
              { key: "shortLabel", label: "Short label", hint: "For the compact toggle." },
            ]}
          />
        </FormSection>
      ),
    },
    {
      id: "home",
      label: "Homepage section types",
      group: "Portal lists",
      dirty: changed(draft.homeSectionKinds, saved.homeSectionKinds) || changed(draft.homeSectionSources, saved.homeSectionSources),
      content: (
        <FormSection
          title="Homepage section types"
          description="The section types you can add, and whether each shows products."
        >
          <RecordListEditor<Labelled & { needsSource: boolean }>
            rows={draft.homeSectionKinds ?? []}
            onChange={(homeSectionKinds) => patch("homeSectionKinds", homeSectionKinds)}
            title={(row) => row.label || "New kind"}
            addLabel="Add a section kind"
            blank={() => ({ value: "", label: "", needsSource: false })}
            fields={[
              { key: "value", label: "Value", hint: "Must be a section type the homepage supports." },
              { key: "label", label: "Label" },
              { key: "needsSource", label: "Needs a product source", kind: "toggle" },
            ]}
          />

          <div className="mt-4">
            <p className="mb-2.5 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
              Product lists
            </p>
            <RecordListEditor<Labelled>
              rows={draft.homeSectionSources ?? []}
              onChange={(homeSectionSources) => patch("homeSectionSources", homeSectionSources)}
              title={(row) => row.label || "New source"}
              addLabel="Add a source"
              blank={() => ({ value: "", label: "" })}
              fields={[
                { key: "value", label: "Value" },
                { key: "label", label: "Label" },
              ]}
            />
          </div>
        </FormSection>
      ),
    },
  ];

  return (
    <div>
      <AdminPageHeader
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Content" }]}
        title="Content"
        description="The lists the storefront and this portal render — states, methods, the FAQ, size charts and every dropdown."
      />

      <SettingsLayout label="Content sections" sections={sections} active={section} onChange={setSection} />

      <SettingsSaveBar
        dirtySections={sections.filter((entry) => entry.dirty).map((entry) => entry.label)}
        saving={saving}
        onSave={() => void onSave()}
        onDiscard={() => setDraft(data)}
        saveLabel="Save content"
      />
    </div>
  );
}

/**
 * A list of numbers.
 *
 * `TagListInput` holds strings, and these are compared numerically when the
 * filter runs — storing "4" where 4 is meant is how a filter silently stops
 * matching.
 */
function NumberListInput({
  label,
  hint,
  values,
  onChange,
}: {
  label: string;
  hint?: string;
  values: number[];
  onChange: (values: number[]) => void;
}) {
  return (
    <TagListInput
      label={label}
      hint={hint}
      values={values.map(String)}
      onChange={(next) =>
        onChange(
          next
            .map((entry) => Number(entry))
            .filter((entry) => Number.isFinite(entry) && entry > 0),
        )
      }
      placeholder="Add a number and press Enter"
    />
  );
}

/**
 * The size charts.
 *
 * A chart is a heading, a set of column names and rows of cells — a table
 * inside a record, which is one nesting level past what `RecordListEditor`
 * handles. Columns and rows are edited as comma-separated text because that is
 * how somebody with a supplier's measurements in a spreadsheet will paste them.
 */
function SizeChartsEditor({
  charts,
  onChange,
}: {
  charts: SizeChart[];
  onChange: (charts: SizeChart[]) => void;
}) {
  const patch = (index: number, next: Partial<SizeChart>) =>
    onChange(charts.map((chart, i) => (i === index ? { ...chart, ...next } : chart)));

  return (
    <div className="mt-4 flex flex-col gap-4">
      <RecordListEditor<{ title: string }>
        rows={charts.map(({ title }) => ({ title }))}
        onChange={(rows) =>
          onChange(
            rows.map((row, index) => ({
              title: row.title,
              columns: charts[index]?.columns ?? [],
              rows: charts[index]?.rows ?? [],
            })),
          )
        }
        title={(row) => row.title || "New chart"}
        addLabel="Add a size chart"
        blank={() => ({ title: "" })}
        fields={[{ key: "title", label: "Chart title", span: "full" }]}
      />

      {charts.map((chart, index) => (
        <div key={index} className="rounded-[3px] border border-admin-border bg-admin-plane p-3.5">
          <p className="mb-2.5 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
            “{chart.title || `chart ${index + 1}`}” measurements
          </p>

          <AdminInput
            label="Columns"
            value={(chart.columns ?? []).join(", ")}
            onChange={(event) =>
              patch(index, { columns: splitRow(event.target.value) })
            }
            hint="Comma separated, e.g. Size, Bust, Waist, Hip."
          />

          <div className="mt-3">
            <AdminTextarea
              label="Rows"
              rows={Math.max(4, (chart.rows ?? []).length + 1)}
              value={(chart.rows ?? []).map((row) => row.join(", ")).join("\n")}
              onChange={(event) =>
                patch(index, {
                  rows: event.target.value
                    .split("\n")
                    .map(splitRow)
                    .filter((row) => row.length > 0),
                })
              }
              hint="One row per line, cells comma separated. Paste straight from a spreadsheet."
            />
          </div>
        </div>
      ))}
    </div>
  );
}

const splitRow = (value: string): string[] =>
  value
    .split(",")
    .map((cell) => cell.trim())
    .filter(Boolean);
