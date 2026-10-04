"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

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
import { SettingsLayout, useSettingsSection, type SettingsSection } from "@/components/admin/ui/SettingsLayout";
import { IdSelector } from "@/components/common/IdSelector";
import { ProductSuppliersPanel } from "@/components/admin/views/suppliers/ProductSuppliersPanel";
import { ProductDeliveryRulesPanel } from "@/components/admin/views/discovery/ProductDeliveryRulesPanel";
import { ProductRelationshipsPanel } from "@/components/admin/views/discovery/ProductRelationshipsPanel";
import { ProductSizeGuidePanel } from "@/components/admin/views/discovery/ProductSizeGuidePanel";
import { ProductAttributesPanel } from "@/components/admin/views/search/ProductAttributesPanel";
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

/** Which section each validated field lives in. */
const ERROR_SECTION: Record<string, string> = {
  name: "basics",
  brand: "basics",
  category: "basics",
  subcategory: "basics",
  description: "basics",
  price: "pricing",
  originalPrice: "pricing",
  stock: "inventory",
  colors: "colours",
  images: "photos",
};

const SECTION_ORDER = [
  "basics", "pricing", "inventory", "variants", "colours", "photos", "status", "merchandising", "returns", "tags", "seo",
];

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
  // Suppliers exist only for a saved product, so that section is on edit only.
  // Suppliers, relationships, the size guide and delivery rules hang off a
  // saved product, so those sections are on edit only.
  const [section, setSection] = useSettingsSection(
    mode === "edit" ? [...SECTION_ORDER, "attributes", "related", "size-guide", "delivery", "suppliers"] : SECTION_ORDER,
  );
  const [saving, setSaving] = useState(false);
  const [seeded, setSeeded] = useState(mode === "create");

  // Seed once, when the product arrives. Guarded so a later reload cannot
  // overwrite edits the admin has already typed. Done while rendering (React's
  // "adjust state when a prop changes" pattern) rather than in an effect.
  if (mode === "edit" && !seeded && existing.data) {
    // `discount` and the audit fields are derived on save, so the form never
    // holds them — picking explicitly avoids four unused discards.
    const product = existing.data;
    setDraft({
      id: product.id, slug: product.slug, name: product.name, brand: product.brand,
      category: product.category, categoryId: product.categoryId ?? "", subcategory: product.subcategory,
      price: product.price, originalPrice: product.originalPrice, currency: product.currency,
      rating: product.rating, reviewCount: product.reviewCount,
      images: product.sharedImages ?? product.images,
      colors: product.colors.map((colour) => ({ ...colour, images: colour.images ?? [] })),
      sizes: product.sizes,
      description: product.description, material: product.material, tags: product.tags,
      isNew: product.isNew, isTrending: product.isTrending,
      isBestSeller: product.isBestSeller, isFeatured: product.isFeatured,
      isReturnable: product.isReturnable ?? true, isReplaceable: product.isReplaceable ?? true,
      stock: product.stock, sku: product.sku, care: product.care,
      specifications: product.specifications,
      status: product.status, lowStockThreshold: product.lowStockThreshold,
      reservedStock: product.reservedStock, barcode: product.barcode,
      taxRatePercent: product.taxRatePercent, seo: product.seo,
    });
    setSeeded(true);
  }

  const categories = categoriesResource.data ?? [];
  // The category is identified by its ID; the list only supplies its product
  // types (and the slug the storefront's URLs still use).
  const selectedCategory = draft.categoryId
    ? categories.find((entry) => entry.id === draft.categoryId)
    : undefined;

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

  const chooseCategory = (categoryId: string | null) => {
    const chosen = categoryId ? categories.find((entry) => entry.id === categoryId) : undefined;
    setDraft((current) => ({
      ...current,
      categoryId: categoryId ?? "",
      category: chosen?.slug ?? "",
      // The old product type almost certainly does not exist in the new
      // category, so clear it rather than leave it invalid.
      subcategory: categoryId === current.categoryId ? current.subcategory : "",
    }));
    setErrors((current) => {
      if (!current.category) return current;
      const next = { ...current };
      delete next.category;
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
      // Open the first section holding a problem; the others are marked in the menu.
      const first = SECTION_ORDER.find((id) => Object.keys(found).some((key) => ERROR_SECTION[key] === id));
      if (first) setSection(first);
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
            We couldn&rsquo;t find this product. It may have been deleted.
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

  const hasError = (keys: string[]) => keys.some((key) => Boolean(errors[key]));
  const sections: SettingsSection[] = [
    {
      id: "basics",
      label: "Basic information",
      group: "Product",
      error: hasError(["name", "brand", "category", "subcategory", "description"]),
      content: (
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

            <div className="flex flex-col gap-1.5">
              <IdSelector
                entity="category"
                label="Category ID"
                required
                compact
                value={draft.categoryId}
                onChange={chooseCategory}
              />
              {selectedCategory ? (
                <p className="text-[0.6875rem] text-admin-muted">{selectedCategory.name}</p>
              ) : null}
              {errors.category ? (
                <p role="alert" className="text-[0.6875rem] text-[#c23434]">
                  {errors.category}
                </p>
              ) : null}
            </div>

            <AdminSelect
              label="Product type"
              value={draft.subcategory}
              onChange={(event) => set("subcategory", event.target.value)}
              error={errors.subcategory}
              required
              disabled={!draft.categoryId}
              placeholder={draft.categoryId ? "Choose a type" : "Pick a category first"}
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
      ),
    },
    {
      id: "pricing",
      label: "Pricing",
      group: "Product",
      error: hasError(["price", "originalPrice"]),
      content: (
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
            The discount shown to shoppers is worked out from these two prices.
            {draft.originalPrice > draft.price ? (
              <strong className="ml-1 text-admin-ink">
                This will show {Math.floor(((draft.originalPrice - draft.price) / draft.originalPrice) * 100)}% off.
              </strong>
            ) : null}
          </p>
        </FormSection>
      ),
    },
    {
      id: "inventory",
      label: "Inventory",
      group: "Product",
      error: hasError(["stock"]),
      content: (
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
      ),
    },
    {
      id: "variants",
      label: "Sizes & variants",
      group: "Variants & photos",
      content: (
        <FormSection
          title="Variants"
          description="Leave sizes empty for one-size products."
        >
          <div className="flex flex-col gap-4">
            <TagListInput
              label="Sizes"
              values={draft.sizes}
              onChange={(values) => set("sizes", values)}
              placeholder="S, M, UK 8…"
              hint="Order matters — they appear in this order on the product page."
            />

          </div>
        </FormSection>
      ),
    },
    {
      id: "colours",
      label: "Colours & photos",
      group: "Variants & photos",
      error: hasError(["colors"]),
      content: (
        <FormSection
          title="Colours & photos"
          description="Add each colour the product is sold in, with photos of the product in that colour. Shoppers see a colour's own photos when they choose it, and each photographed colour gets its own card in product listings."
        >
          <ColourEditor
            colors={draft.colors}
            onChange={(colors) => set("colors", colors)}
            error={errors.colors}
          />
        </FormSection>
      ),
    },
    {
      id: "photos",
      label: "Shared photos",
      group: "Variants & photos",
      error: hasError(["images"]),
      content: (
        <FormSection
          title="Shared photos"
          description={
            draft.colors.some((colour) => colour.images?.length)
              ? "Optional. Shown for the product in general — for example a detail shot that is the same in every colour."
              : "Used for every colour. Add photos to each colour above to show the right one when a shopper picks it."
          }
        >
          <ImageListInput
            label="Shared photos"
            values={draft.images}
            onChange={(values) => set("images", values)}
            error={errors.images}
          />
        </FormSection>
      ),
    },
    {
      id: "status",
      label: "Status",
      group: "Visibility & search",
      content: (
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
      ),
    },
    {
      id: "merchandising",
      label: "Merchandising",
      group: "Visibility & search",
      content: (
        <FormSection title="Merchandising" description="Choose where this product can be featured.">
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
      ),
    },
    {
      id: "returns",
      label: "Returns & replacements",
      group: "Visibility & search",
      content: (
        <FormSection
          title="Returns & replacements"
          description="What customers may do after delivery, within your return window. Each order keeps the policy it was bought under."
        >
          <div className="flex flex-col gap-2.5">
            <AdminCheckbox
              label="Returnable — customers can send it back for a refund"
              checked={draft.isReturnable ?? true}
              onChange={(event) => set("isReturnable", event.target.checked)}
            />
            <AdminCheckbox
              label="Replaceable — customers can exchange it for the same item"
              checked={draft.isReplaceable ?? true}
              onChange={(event) => set("isReplaceable", event.target.checked)}
            />
          </div>
        </FormSection>
      ),
    },
    {
      id: "tags",
      label: "Tags",
      group: "Visibility & search",
      content: (
        <FormSection title="Tags" description="Used by search and recommendations.">
          <TagListInput
            label="Tags"
            values={draft.tags}
            onChange={(values) => set("tags", values)}
            placeholder="linen, summer…"
          />
        </FormSection>
      ),
    },
    {
      id: "seo",
      label: "Search engine listing",
      group: "Visibility & search",
      content: (
        <FormSection title="Search engine listing" description="How this appears in results.">
          <FormGrid>
            <AdminInput
              label="Web address"
              value={draft.slug}
              onChange={(event) => set("slug", event.target.value)}
              hint={
                draft.id
                  ? `Storefront URL: /product/${draft.id} — the slug redirects to it`
                  : "Used in the product's link, for example oversized-cotton-shirt."
              }
              className="sm:col-span-2"
            />

            <AdminInput
              label="Search result title"
              value={draft.seo.metaTitle}
              onChange={(event) => set("seo", { ...draft.seo, metaTitle: event.target.value })}
              hint="Around 60 characters."
              className="sm:col-span-2"
            />

            <AdminTextarea
              label="Search result description"
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
      ),
    },
    ...(mode === "edit" && productId
      ? [
          // Attribute values hang off a saved product too, and save on their own button.
          { id: "attributes", label: "Attributes", group: "Visibility & search",
            content: <ProductAttributesPanel productId={productId} /> },
          { id: "related", label: "Related products", group: "Discovery",
            content: <ProductRelationshipsPanel productId={productId} /> },
          { id: "size-guide", label: "Size guide", group: "Discovery",
            content: <ProductSizeGuidePanel productId={productId} /> },
          { id: "delivery", label: "Delivery rules", group: "Discovery",
            content: <ProductDeliveryRulesPanel productId={productId} /> },
          { id: "suppliers", label: "Suppliers", group: "Purchasing", content: <ProductSuppliersPanel productId={productId} /> },
        ]
      : []),
  ];

  return (
    <div>
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

      <SettingsLayout label="Product sections" sections={sections} active={section} onChange={setSection} />

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
 * Colours, each with its own photographs.
 *
 * A name plus a hex, because the storefront shows a swatch *and* names it — a
 * swatch alone is invisible to anyone who cannot distinguish the colours. And
 * a set of photos per colour, chosen here rather than guessed from the image,
 * so the product page can show the colour the shopper picked.
 */
type ColourDraft = { name: string; hex: string; images?: string[] };

function ColourEditor({
  colors,
  onChange,
  error,
}: {
  colors: ColourDraft[];
  onChange: (colors: ColourDraft[]) => void;
  error?: string;
}) {
  const [name, setName] = useState("");
  const [hex, setHex] = useState("#b5734f");

  const add = () => {
    const trimmed = name.trim();
    if (!trimmed || colors.some((colour) => colour.name.toLowerCase() === trimmed.toLowerCase())) {
      setName("");
      return;
    }
    onChange([...colors, { name: trimmed, hex, images: [] }]);
    setName("");
  };

  const update = (index: number, patch: Partial<ColourDraft>) =>
    onChange(colors.map((colour, at) => (at === index ? { ...colour, ...patch } : colour)));

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= colors.length) return;
    const next = [...colors];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  return (
    <div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="mb-1.5 block text-xs font-medium text-admin-ink">New colour</span>
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
            maxLength={60}
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

      {error ? (
        <p role="alert" className="mt-2 text-[0.6875rem] text-[#c23434]">
          {error}
        </p>
      ) : null}

      {colors.length > 0 ? (
        <ol className="mt-4 flex flex-col gap-3">
          {colors.map((colour, index) => (
            <li
              key={colour.name}
              className="rounded-[3px] border border-admin-border bg-admin-surface p-3"
            >
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <label className="shrink-0">
                  <span className="sr-only">{colour.name} swatch</span>
                  <input
                    type="color"
                    value={colour.hex}
                    onChange={(event) => update(index, { hex: event.target.value })}
                    className="h-7 w-9 cursor-pointer rounded-[3px] border border-admin-border bg-admin-surface p-0.5"
                  />
                </label>
                <p className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-admin-ink">
                  {colour.name}
                  {index === 0 ? (
                    <span className="ml-2 text-[0.625rem] font-normal uppercase tracking-wide text-admin-muted">
                      Shown first
                    </span>
                  ) : null}
                </p>
                <span className="flex items-center gap-1 text-[0.6875rem]">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${colour.name} earlier`}
                    className="rounded-[3px] px-1.5 py-1 text-admin-muted hover:bg-admin-raised disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === colors.length - 1}
                    aria-label={`Move ${colour.name} later`}
                    className="rounded-[3px] px-1.5 py-1 text-admin-muted hover:bg-admin-raised disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange(colors.filter((_, at) => at !== index))}
                    className="rounded-[3px] px-1.5 py-1 text-[#c23434] hover:bg-[#fbeaea]"
                  >
                    Remove
                  </button>
                </span>
              </div>

              <ImageListInput
                label={`Photos in ${colour.name}`}
                values={colour.images ?? []}
                onChange={(images) => update(index, { images })}
                hint="The first photo is the one shown on this colour's product card."

              />
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-[0.6875rem] text-admin-muted">
          No colours yet. Leave empty for products sold in one finish.
        </p>
      )}
    </div>
  );
}
