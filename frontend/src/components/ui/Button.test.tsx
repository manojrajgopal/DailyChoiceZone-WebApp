import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderUI, screen } from "@/test/render";

import { Button, ButtonLink } from "./Button";

describe("Button", () => {
  describe("defaults", () => {
    it("is a primary, medium, type=button button", () => {
      renderUI(<Button>Add to bag</Button>);
      const button = screen.getByRole("button", { name: "Add to bag" });
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveClass("bg-ink", "h-11");
      expect(button).not.toHaveClass("w-full");
    });
  });

  describe("props", () => {
    it.each([
      ["primary", "bg-ink"],
      ["secondary", "bg-copper-500"],
      ["outline", "border-ink"],
      ["ghost", "bg-transparent"],
      ["sale", "bg-clay-500"],
    ] as const)("applies the %s variant", (variant, cls) => {
      renderUI(<Button variant={variant}>Go</Button>);
      expect(screen.getByRole("button")).toHaveClass(cls);
    });

    it.each([
      ["sm", "h-9"],
      ["md", "h-11"],
      ["lg", "h-14"],
    ] as const)("applies the %s size", (size, cls) => {
      renderUI(<Button size={size}>Go</Button>);
      expect(screen.getByRole("button")).toHaveClass(cls);
    });

    it("stretches with fullWidth, keeps a submit type and forwards the ref", () => {
      const ref = createRef<HTMLButtonElement>();
      renderUI(<Button ref={ref} type="submit" fullWidth className="mt-2">Pay</Button>);
      const button = screen.getByRole("button", { name: "Pay" });
      expect(button).toHaveAttribute("type", "submit");
      expect(button).toHaveClass("w-full", "mt-2");
      expect(ref.current).toBe(button);
    });
  });

  describe("interaction", () => {
    it("calls onClick when enabled and not when disabled", async () => {
      const onClick = vi.fn();
      const { user, rerender } = renderUI(<Button onClick={onClick}>Buy</Button>);
      await user.click(screen.getByRole("button"));
      expect(onClick).toHaveBeenCalledOnce();
      rerender(<Button onClick={onClick} disabled>Buy</Button>);
      expect(screen.getByRole("button")).toBeDisabled();
      await user.click(screen.getByRole("button"));
      expect(onClick).toHaveBeenCalledOnce();
    });
  });
});

describe("ButtonLink", () => {
  it("is a link styled as a button with its href", () => {
    const ref = createRef<HTMLAnchorElement>();
    renderUI(<ButtonLink ref={ref} href="/shop" variant="outline" size="lg" fullWidth>Shop now</ButtonLink>);
    const link = screen.getByRole("link", { name: "Shop now" });
    expect(link).toHaveAttribute("href", "/shop");
    expect(link).toHaveClass("border-ink", "h-14", "w-full");
    expect(ref.current).toBe(link);
  });

  it("defaults to primary medium", () => {
    renderUI(<ButtonLink href="/x">X</ButtonLink>);
    expect(screen.getByRole("link")).toHaveClass("bg-ink", "h-11");
  });
});
