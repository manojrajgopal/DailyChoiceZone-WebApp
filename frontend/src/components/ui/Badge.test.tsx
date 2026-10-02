import { describe, expect, it } from "vitest";

import { renderUI, screen } from "@/test/render";

import { Badge } from "./Badge";

describe("Badge", () => {
  it("renders its content with the neutral tone by default", () => {
    renderUI(<Badge>Limited</Badge>);
    expect(screen.getByText("Limited")).toHaveClass("bg-cream-deep", "text-ink-700");
  });

  it.each([
    ["new", "bg-ink"],
    ["bestseller", "bg-blush-200"],
    ["sale", "bg-clay-500"],
    ["neutral", "bg-cream-deep"],
    ["stock", "bg-sage-100"],
    ["soldout", "bg-ink-200"],
  ] as const)("maps the %s tone to %s", (tone, cls) => {
    renderUI(<Badge tone={tone}>{tone}</Badge>);
    expect(screen.getByText(tone)).toHaveClass(cls);
  });

  it("merges a custom class name", () => {
    renderUI(<Badge className="absolute">Sale</Badge>);
    expect(screen.getByText("Sale")).toHaveClass("absolute", "rounded-control");
  });
});
