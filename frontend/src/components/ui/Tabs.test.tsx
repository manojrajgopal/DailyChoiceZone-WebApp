import { describe, expect, it } from "vitest";

import { renderUI, screen } from "@/test/render";

import { Tabs, type Tab } from "./Tabs";

const TABS: Tab[] = [
  { id: "details", label: "Details", content: <p>Fabric and fit</p> },
  { id: "care", label: "Care", content: <p>Hand wash</p> },
  { id: "delivery", label: "Delivery", content: <p>Ships in 2 days</p> },
];

describe("Tabs", () => {
  describe("rendering", () => {
    it("renders nothing without tabs", () => {
      const { container } = renderUI(<Tabs tabs={[]} />);
      expect(container).toBeEmptyDOMElement();
    });

    it("selects the first tab and renders only its panel content", () => {
      renderUI(<Tabs tabs={TABS} className="t" />);
      const first = screen.getByRole("tab", { name: "Details" });
      expect(first).toHaveAttribute("aria-selected", "true");
      expect(first).toHaveAttribute("tabindex", "0");
      expect(screen.getByRole("tab", { name: "Care" })).toHaveAttribute("tabindex", "-1");
      expect(screen.getByRole("tabpanel", { name: "Details" })).toHaveTextContent("Fabric and fit");
      expect(screen.queryByText("Hand wash")).not.toBeInTheDocument();
      expect(screen.getByRole("tablist").parentElement).toHaveClass("t");
    });
  });

  describe("interaction", () => {
    it("switches panels on click", async () => {
      const { user } = renderUI(<Tabs tabs={TABS} />);
      await user.click(screen.getByRole("tab", { name: "Care" }));
      expect(screen.getByRole("tab", { name: "Care" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tabpanel")).toHaveTextContent("Hand wash");
      expect(screen.queryByText("Fabric and fit")).not.toBeInTheDocument();
    });

    it("moves with the arrow keys, wrapping at both ends, and moves focus", async () => {
      const { user } = renderUI(<Tabs tabs={TABS} />);
      await user.click(screen.getByRole("tab", { name: "Details" }));
      await user.keyboard("{ArrowLeft}");
      expect(screen.getByRole("tab", { name: "Delivery" })).toHaveFocus();
      expect(screen.getByRole("tabpanel")).toHaveTextContent("Ships in 2 days");
      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("tab", { name: "Details" })).toHaveFocus();
      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("tab", { name: "Care" })).toHaveAttribute("aria-selected", "true");
    });

    it("ignores other keys", async () => {
      const { user } = renderUI(<Tabs tabs={TABS} />);
      await user.click(screen.getByRole("tab", { name: "Details" }));
      await user.keyboard("{ArrowDown}a");
      expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
    });

    it("works with a single tab", async () => {
      const { user } = renderUI(<Tabs tabs={[TABS[0]!]} />);
      await user.click(screen.getByRole("tab"));
      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("tab")).toHaveAttribute("aria-selected", "true");
    });
  });
});
