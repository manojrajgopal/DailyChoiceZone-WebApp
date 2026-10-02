import { describe, expect, it, vi } from "vitest";

import { renderUI, screen, within } from "@/test/render";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader, ConfirmDialog } from "./AdminChrome";

describe("AdminButton", () => {
  it("defaults to a type=button secondary button that fires onClick", async () => {
    const onClick = vi.fn();
    const { user } = renderUI(<AdminButton onClick={onClick}>Save</AdminButton>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "button");
    expect(button.className).toContain("border-admin-border-strong");
    expect(button.className).toContain("h-9");
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each([
    ["primary", "bg-copper-600"],
    ["ghost", "hover:bg-admin-raised"],
    ["danger", "bg-[#c23434]"],
  ] as const)("applies the %s variant", (variant, cls) => {
    renderUI(<AdminButton variant={variant} size="sm">Go</AdminButton>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.className).toContain(cls);
    expect(button.className).toContain("h-8");
  });

  it("is disabled and shows a spinner while loading, and ignores clicks", async () => {
    const onClick = vi.fn();
    const { user, container } = renderUI(<AdminButton loading onClick={onClick} type="submit">Send</AdminButton>);
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("type", "submit");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is disabled when disabled is passed without loading, with no spinner", () => {
    const { container } = renderUI(<AdminButton disabled className="extra">X</AdminButton>);
    expect(screen.getByRole("button", { name: "X" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "X" })).toHaveClass("extra");
    expect(container.querySelector(".animate-spin")).toBeNull();
  });
});

describe("AdminButtonLink", () => {
  it("renders a link with the variant styling", () => {
    renderUI(<AdminButtonLink href="/admin/x" variant="primary" size="sm" className="k">New</AdminButtonLink>);
    const link = screen.getByRole("link", { name: "New" });
    expect(link).toHaveAttribute("href", "/admin/x");
    expect(link.className).toContain("bg-copper-600");
    expect(link).toHaveClass("k");
  });

  it("defaults to secondary/md", () => {
    renderUI(<AdminButtonLink href="/a">A</AdminButtonLink>);
    expect(screen.getByRole("link", { name: "A" }).className).toContain("h-9");
  });
});

describe("AdminCard", () => {
  it("renders a titled header with description and action, and pads the body", () => {
    renderUI(
      <AdminCard title="Orders" description="Last 30 days" action={<button>Export</button>} className="c">
        <p>body</p>
      </AdminCard>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Orders" })).toBeInTheDocument();
    expect(screen.getByText("Last 30 days")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByText("body").parentElement).toHaveClass("p-4");
  });

  it("omits the header without a title and the padding when padded=false", () => {
    renderUI(<AdminCard padded={false}><p>table</p></AdminCard>);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByText("table").parentElement).not.toHaveClass("p-4");
  });

  it("omits the description when none is given", () => {
    renderUI(<AdminCard title="T"><p>b</p></AdminCard>);
    expect(screen.getByRole("heading", { name: "T" }).nextSibling).toBeNull();
  });
});

describe("AdminPageHeader", () => {
  it("renders breadcrumbs linking all but the last, which is the current page", () => {
    renderUI(
      <AdminPageHeader
        title="Edit product"
        description="Change things"
        breadcrumbs={[{ label: "Products", href: "/admin/products" }, { label: "No link" }, { label: "Edit", href: "/ignored" }]}
        actions={<button>Save</button>}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByRole("link", { name: "Products" })).toHaveAttribute("href", "/admin/products");
    expect(within(nav).queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(nav).getByText("Edit")).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByText("No link")).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("heading", { level: 1, name: "Edit product" })).toBeInTheDocument();
    expect(screen.getByText("Change things")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("renders no breadcrumb nav for an empty list, and no description/actions", () => {
    renderUI(<AdminPageHeader title="Home" breadcrumbs={[]} />);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Home" }).nextSibling).toBeNull();
  });
});

describe("ConfirmDialog", () => {
  function setup(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    const view = renderUI(
      <ConfirmDialog open title="Delete product?" message="This cannot be undone." onOpenChange={onOpenChange} onConfirm={onConfirm} {...props} />,
    );
    return { ...view, onOpenChange, onConfirm };
  }

  it("confirms with the destructive Delete button", async () => {
    const { user, onConfirm, onOpenChange } = setup();
    const dialog = screen.getByRole("dialog", { name: "Delete product?" });
    expect(within(dialog).getByText("This cannot be undone.")).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm.className).toContain("bg-[#c23434]");
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("cancels by closing without confirming", async () => {
    const { user, onConfirm, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses a primary button and a custom label when not destructive", () => {
    setup({ destructive: false, confirmLabel: "Publish" });
    expect(screen.getByRole("button", { name: "Publish" }).className).toContain("bg-copper-600");
  });

  it("disables both buttons while loading", () => {
    setup({ loading: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("renders nothing when closed", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
