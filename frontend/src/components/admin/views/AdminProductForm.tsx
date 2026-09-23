"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import type { Category } from "@/types";
import type { ProductDraft, ProductStatus } from "@/types/admin";

import {
  AdminButton,
  AdminButtonLink,
  AdminPageHeader,
} from "@/components/admin/ui/AdminChrome";
import {
  AdminCheckbox,
  AdminInput,
  AdminSelect,
  AdminTextarea,
  FormGrid,
  FormSection,
  ImageListInput,
  TagListInput,
} from "@/components/admin/ui/AdminForm";
import { useAdminResource } from "@/hooks/useAdminResource";
import { slugify } from "@/lib/utils/format";
import { currentActorId } from "@/services/admin/adminAuthService";
import { listCategories } from "@/services/admin/categoryAdminService";
import {
  createProduct,
  emptyProductDraft,
  getProduct,
  updateProduct,
  validateProduct,
} from "@/services/admin/productAdminService";
import { toast } from "@/store/toastStore";

/**
 * The product form, shared by Add and Edit.
 *
 * One component rather than two, because the fields, the validation and the
 * derived values are identical — only where the draft comes from and what the
 * save button says differ. Two copies would drift the moment a field is added.
 */
export function AdminProductForm({ mode }: { mode: "create" | "edit" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const productId = searchParams?.get("id") ?? "";

  const categoriesResource = useAdminResource(() => listCategories(), []);
  const existing = useAdminResource(
    () => (mode === "edit" && productId ? getProduct(productId) : Promise.resolve(null)),
    [mode, productId],
  );

  const [draft, setDraft] = useState<ProductDraft>(() => emptyProductDraft());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [seeded, setSeeded] = useState(mode === "create");

  // Seed once, when the product arrives. Guarded so a later reload cannot
  // overwrite edits the admin has already typed.
  useEffect(() => {
    if (mode !== "edit" || seeded || !existing.data) return;
    // `discount` and the audit fields are derived on save, so the form never
    // holds them — picking explicitly avoids four unused discards.
    const product = existing.data;
    setDraft({
      id: product.id, slug: product.slug, name: product.name, brand: product.brand,
      category: product.category, subcategory: product.subcategory,
      price: product.price, originalPrice: product.originalPrice, currency: product.currency,
      rating: product.rating, reviewCount: product.reviewCount,
      images: product.images, colors: product.colors, sizes: product.sizes,
      description: product.description, material: product.material, tags: product.tags,
      isNew: product.isNew, isTrending: product.isTrending,
      isBestSeller: product.isBestSeller, isFeatured: product.isFeatured,
      stock: product.stock, sku: product.sku, care: product.care,
      specifications: product.specifications,
      status: product.status, lowStockThreshold: product.lowStockThreshold,
      reservedStock: product.reservedStock, barcode: product.barcode,
      taxRatePercent: product.taxRatePercent, seo: product.seo,
    });
    setSeeded(true);
  }, [mode, seeded, existing.data]);

  const categories = categoriesResource.data ?? [];
  const selectedCategory = categories.find((entry) => entry.slug === draft.category);

  const subcategories = useMemo(
    () => (selectedCategory?.groups ?? []).flatMap((group) => group.items),
    [selectedCategory],
  );

  const set = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!current[key as string]) return current;
      const next = { ...current };
      delete next[key as string];
      return next;
    });
  };

  const save = async (status: ProductStatus) => {
    const candidate: ProductDraft = {
      ...draft,
      status,
      // Auto-slug from the name when the admin has not set one.
      slug: draft.slug.trim() || slugify(draft.name),
    };

    const found = validateProduct(candidate);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      toast.error("Check the highlighted fields.");
      return;
    }

    setSaving(true);
    const result =
      mode === "create"
        ? await createProduct(candidate, currentActorId())
        : await updateProduct(candidate, currentActorId());
    setSaving(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(
      mode === "create"
        ? status === "draft"
          ? "Draft saved"
          : `${result.data.name} published`
        : "Product updated",
    );
    router.push("/admin/products");
  };

  if (mode === "edit" && existing.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading product" />
      </div>
    );
  }

  if (mode === "edit" && !existing.data) {
    return (
      <div>
        <AdminPageHeader
          title="Product not found"
          breadcrumbs={[
            { label: "Admin", href: "/admin/dashboard" },
            { label: "Products", href: "/admin/products" },
            { label: "Not found" },
          ]}
        />
        <div className="rounded-[3px] border border-admin-border bg-admin-surface p-8 text-center">
          <p className="text-sm text-admin-ink">
            We could not find a product with the id <code>{productId || "(none)"}</code>.
          </p>
          <p className="mt-1.5 text-xs text-admin-muted">
            It may have been deleted, or the link may be out of date.
          </p>
          <AdminButtonLink href="/admin/products" variant="secondary" className="mt-5">
            Back to products
          </AdminButtonLink>
        </div>
      </div>
    );
  }

  return (
    <div className="pb-24">
      <AdminPageHeader
        title={mode === "create" ? "Add product" : `Edit ${existing.data?.name ?? "product"}`}
        description={
          mode === "create"
            ? "Save as a draft at any point — only publishing requires every field."
            : "Changes apply to the storefront as soon as you save."
        }
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Products", href: "/admin/products" },
          { label: mode === "create" ? "New" : "Edit" },
        ]}
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          {/* --------------------------------------------- basic information */}
          <FormSection
            title="Basic information"
            description="What the product is and where it sits in the catalogue."
          >
            <FormGrid>
              <AdminInput
                label="Product name"
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                error={errors.name}
                required
                className="sm:col-span-2"
                placeholder="Oversized Cotton Shirt"
              />

              <AdminInput
                label="Brand"
                value={draft.brand}
                onChange={(event) => set("brand", event.target.value)}
                error={errors.brand}
                required
              />

              <AdminInput
                label="SKU"
                value={draft.sku}
                onChange={(event) => set("sku", event.target.value)}
                hint="Leave blank to generate one from the category."
                placeholder="DCZ-WO0140"
              />

              <AdminSelect
                label="Category"
                value={draft.category}
                onChange={(event) => {
                  set("category", event.target.value);
                  // The old subcategory almost certainly does not exist in the
                  // new category, so clear it rather than leave it invalid.
                  set("subcategory", "");
                }}
                error={errors.category}
                required
                placeholder="Choose a category"
                options={categories.map((entry: Category) => ({
                  value: entry.slug,
                  label: entry.name,
                }))}
              />

              <AdminSelect
                label="Product type"
                value={draft.subcategory}
                onChange={(event) => set("subcategory", event.target.value)}
                error={errors.subcategory}
                required
                disabled={!draft.category}
                placeholder={draft.category ? "Choose a type" : "Pick a category first"}
                options={subcategories.map((entry) => ({
                  value: entry.slug,
                  label: entry.name,
                }))}
              />

              <AdminTextarea
                label="Description"
                value={draft.description}
                onChange={(event) => set("description", event.target.value)}
                error={errors.description}
                required
                rows={5}
                className="sm:col-span-2"
                hint="Plain text. Describe the fit, the feel and anything a photograph cannot show."
              />

              <AdminInput
                label="Material"
                value={draft.material}
                onChange={(event) => set("material", event.target.value)}
                placeholder="Cotton Poplin"
              />

              <AdminInput
                label="Care instructions"
                value={draft.care}
                onChange={(event) => set("care", event.target.value)}
                placeholder="Machine wash cold with like colours."
              />
            </FormGrid>
          </FormSection>

          {/* ------------------------------------------------------- pricing */}
          <FormSection title="Pricing" description="All figures in rupees, inclusive of tax.">
            <FormGrid columns={3}>
              <AdminInput
                label="Selling price"
                type="number"
                min={0}
                prefix="₹"
                value={draft.price || ""}
                onChange={(event) => set("price", Number(event.target.value))}
                error={errors.price}
                required
              />

              <AdminInput
                label="Original price"
                type="number"
                min={0}
                prefix="₹"
                value={draft.originalPrice || ""}
                onChange={(event) => set("originalPrice", Number(event.target.value))}
                error={errors.originalPrice}
                hint="Set equal to the selling price if it is not reduced."
              />

              <AdminInput
                label="Tax rate"
                type="number"
                min={0}
                max={28}
                value={draft.taxRatePercent}
                onChange={(event) => set("taxRatePercent", Number(event.target.value))}
                hint="Percent."
              />
            </FormGrid>

            <p className="mt-3 rounded-[3px] bg-admin-raised px-3 py-2 text-[0.6875rem] text-admin-muted">
              The discount badge is calculated from these two prices, never typed in — so what the
              shopper sees always matches the arithmetic.
              {draft.originalPrice > draft.price ? (
                <strong className="ml-1 text-admin-ink">
                  This will show {Math.floor(((draft.originalPrice - draft.price) / draft.originalPrice) * 100)}% off.
                </strong>
              ) : null}
            </p>
          </FormSection>

          {/* ----------------------------------------------------- inventory */}
          <FormSection title="Inventory" description="Stock levels and identifiers.">
            <FormGrid columns={3}>
              <AdminInput
                label="Stock quantity"
                type="number"
                min={0}
                value={draft.stock}
                onChange={(event) => set("stock", Number(event.target.value))}
                error={errors.stock}
              />

              <AdminInput
                label="Low stock threshold"
                type="number"
                min={0}
                value={draft.lowStockThreshold}
                onChange={(event) => set("lowStockThreshold", Number(event.target.value))}
                hint="Warn below this level."
              />

              <AdminInput
                label="Barcode"
                value={draft.barcode}
                onChange={(event) => set("barcode", event.target.value)}
                placeholder="8901234567890"
              />
            </FormGrid>
          </FormSection>

          {/* ------------------------------------------------------ variants */}
          <FormSection
            title="Variants"
            description="Leave sizes empty for products where size is meaningless."
          >
            <div className="flex flex-col gap-4">
              <TagListInput
                label="Sizes"
                values={draft.sizes}
                onChange={(values) => set("sizes", values)}
                placeholder="S, M, UK 8…"
                hint="Order matters — they appear in this order on the product page."
              />

              <div>
                <p className="mb-1.5 text-xs font-medium text-admin-ink">Colours</p>
                <ColourEditor
                  colors={draft.colors}
                  onChange={(colors) => set("colors", colors)}
                />
              </div>
            </div>
          </FormSection>

          {/* -------------------------------------------------------- images */}
          <FormSection title="Images" description="The first image is the primary one.">
            <ImageListInput
              label="Product images"
              values={draft.images}
              onChange={(values) => set("images", values)}
              error={errors.images}
            />
          </FormSection>

          {/* ----------------------------------------------------------- SEO */}
          <FormSection title="Search engine listing" description="How this appears in results.">
            <FormGrid>
              <AdminInput
                label="URL slug"
                value={draft.slug}
                onChange={(event) => set("slug", event.target.value)}
                hint={`Storefront URL: /product/${draft.slug || slugify(draft.name) || "…"}`}
                className="sm:col-span-2"
              />

              <AdminInput
                label="Meta title"
                value={draft.seo.metaTitle}
                onChange={(event) => set("seo", { ...draft.seo, metaTitle: event.target.value })}
                hint="Around 60 characters."
                className="sm:col-span-2"
              />

              <AdminTextarea
                label="Meta description"
                rows={3}
                value={draft.seo.metaDescription}
                onChange={(event) =>
                  set("seo", { ...draft.seo, metaDescription: event.target.value })
                }
                hint="Around 155 characters."
                className="sm:col-span-2"
              />
            </FormGrid>
          </FormSection>
        </div>

        {/* ----------------------------------------------------- side column */}
        <div className="flex flex-col gap-4">
          <FormSection title="Status">
            <AdminSelect
              label="Publication status"
              value={draft.status}
              onChange={(event) => set("status", event.target.value as ProductStatus)}
              options={[
                { value: "draft", label: "Draft — hidden from the storefront" },
                { value: "active", label: "Active — on sale" },
                { value: "out-of-stock", label: "Out of stock — visible, not buyable" },
                { value: "archived", label: "Archived — hidden and delisted" },
              ]}
            />
            <p className="mt-2 text-[0.6875rem] leading-relaxed text-admin-muted">
              Only Active and Out of stock products appear on the storefront. Setting stock to zero
              moves an Active product to Out of stock automatically.
            </p>
          </FormSection>

          <FormSection title="Merchandising" description="Which homepage rails can pick this up.">
            <div className="flex flex-col gap-1">
              <AdminCheckbox
                label="New arrival"
                checked={draft.isNew}
                onChange={(event) => set("isNew", event.target.checked)}
              />
              <AdminCheckbox
                label="Trending"
                checked={draft.isTrending}
                onChange={(event) => set("isTrending", event.target.checked)}
              />
              <AdminCheckbox
                label="Best seller"
                checked={draft.isBestSeller}
                onChange={(event) => set("isBestSeller", event.target.checked)}
              />
              <AdminCheckbox
                label="Featured"
                checked={draft.isFeatured}
                onChange={(event) => set("isFeatured", event.target.checked)}
              />
            </div>
          </FormSection>

          <FormSection title="Tags" description="Used by search and recommendations.">
            <TagListInput
              label="Tags"
              values={draft.tags}
              onChange={(values) => set("tags", values)}
              placeholder="linen, summer…"
            />
          </FormSection>
        </div>
      </div>

      {/* ---------------------------------------------------- sticky actions */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-admin-border bg-admin-surface/95 px-4 py-3 backdrop-blur-sm lg:left-60">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <AdminButtonLink href="/admin/products" variant="ghost">
            Cancel
          </AdminButtonLink>

          {draft.status !== "active" ? (
            <AdminButton
              variant="secondary"
              onClick={() => void save("draft")}
              loading={saving}
            >
              Save draft
            </AdminButton>
          ) : null}

          <AdminButton
            variant="primary"
            onClick={() => void save(draft.status === "draft" ? "active" : draft.status)}
            loading={saving}
          >
            {mode === "create"
              ? draft.status === "draft"
                ? "Publish product"
                : "Create product"
              : "Save changes"}
          </AdminButton>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- colours */

/**
 * Colour variants.
 *
 * A name plus a hex, because the storefront shows a swatch *and* names it — a
 * swatch alone is invisible to anyone who cannot distinguish the colours.
 */
function ColourEditor({
  colors,
  onChange,
}: {
  colors: { name: string; hex: string }[];
  onChange: (colors: { name: string; hex: string }[]) => void;
}) {
  const [name, setName] = useState("");
  const [hex, setHex] = useState("#b5734f");

  const add = () => {
    const trimmed = name.trim();
    if (!trimmed || colors.some((colour) => colour.name === trimmed)) {
      setName("");
      return;
    }
    onChange([...colors, { name: trimmed, hex }]);
    setName("");
  };

  return (
    <div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Colour name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
            placeholder="Terracotta"
            className="h-9 w-full rounded-[3px] border border-admin-border bg-admin-surface px-2.5 text-[0.8125rem] text-admin-ink placeholder:text-admin-faint focus:border-copper-500"
          />
        </label>

        <label className="shrink-0">
          <span className="sr-only">Colour swatch</span>
          <input
            type="color"
            value={hex}
            onChange={(event) => setHex(event.target.value)}
            className="h-9 w-12 cursor-pointer rounded-[3px] border border-admin-border bg-admin-surface p-1"
          />
        </label>

        <AdminButton size="md" onClick={add}>
          Add colour
        </AdminButton>
      </div>

      {colors.length > 0 ? (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {colors.map((colour) => (
            <li key={colour.name}>
              <span className="inline-flex items-center gap-1.5 rounded-[3px] bg-admin-raised px-2 py-1 text-[0.6875rem] text-admin-ink ring-1 ring-inset ring-admin-border">
                <span
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 rounded-pill ring-1 ring-inset ring-black/15"
                  style={{ backgroundColor: colour.hex }}
                />
                {colour.name}
                <button
                  type="button"
                  onClick={() => onChange(colors.filter((entry) => entry.name !== colour.name))}
                  aria-label={`Remove ${colour.name}`}
                  className="text-admin-faint transition-colors hover:text-[#c23434]"
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[0.6875rem] text-admin-muted">
          No colours yet. Leave empty for products sold in one finish.
        </p>
      )}
    </div>
  );
}
