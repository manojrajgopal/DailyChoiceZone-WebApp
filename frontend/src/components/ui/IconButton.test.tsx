import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderUI, screen } from "@/test/render";

import { IconButton } from "./IconButton";

describe("IconButton", () => {
  it("uses the label as accessible name and tooltip, plain md button by default", () => {
    renderUI(<IconButton label="Open search"><svg /></IconButton>);
    const button = screen.getByRole("button", { name: "Open search" });
    expect(button).toHaveAttribute("title", "Open search");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("h-10", "w-10", "text-ink");
  });

  it.each([
    ["plain", "md", "hover:bg-cream-deep", "h-10"],
    ["filled", "sm", "bg-ink", "h-8"],
    ["surface", "md", "bg-shell/90", "h-10"],
  ] as const)("applies the %s variant at %s", (variant, size, variantClass, sizeClass) => {
    renderUI(<IconButton label="x" variant={variant} size={size}><svg /></IconButton>);
    expect(screen.getByRole("button")).toHaveClass(variantClass, sizeClass);
  });

  it("clicks, forwards the ref and respects disabled", async () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    const { user, rerender } = renderUI(<IconButton ref={ref} label="Wishlist" onClick={onClick} className="z"><svg /></IconButton>);
    await user.click(screen.getByRole("button", { name: "Wishlist" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(ref.current).toHaveClass("z");
    rerender(<IconButton label="Wishlist" onClick={onClick} disabled type="submit"><svg /></IconButton>);
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
  });
});
