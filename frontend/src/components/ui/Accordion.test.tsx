import { describe, expect, it } from "vitest";

import { renderUI, screen } from "@/test/render";

import { Accordion } from "./Accordion";

describe("Accordion", () => {
  describe("default state", () => {
    it("starts closed with the panel kept in the DOM but hidden", () => {
      renderUI(<Accordion title="Size"><p>Panel body</p></Accordion>);
      const toggle = screen.getByRole("button", { name: "Size" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
      expect(panel).toHaveAttribute("hidden");
      expect(panel).toHaveTextContent("Panel body");
      expect(screen.getByRole("heading", { level: 3 })).toContainElement(toggle);
    });

    it("starts open when defaultOpen is set", () => {
      renderUI(<Accordion title="Colour" defaultOpen><p>Visible</p></Accordion>);
      expect(screen.getByRole("button", { name: "Colour" })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Visible")).toBeVisible();
    });
  });

  describe("interaction", () => {
    it("toggles open and closed on each click", async () => {
      const { user } = renderUI(<Accordion title="Price"><p>Range</p></Accordion>);
      const toggle = screen.getByRole("button", { name: "Price" });
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Range")).toBeVisible();
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByText("Range")).not.toBeVisible();
    });

    it("toggles with the keyboard", async () => {
      const { user } = renderUI(<Accordion title="Brand"><p>Brands</p></Accordion>);
      await user.tab();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("button", { name: "Brand" })).toHaveAttribute("aria-expanded", "true");
    });
  });

  describe("props", () => {
    it("renders the meta hint inside the toggle and applies the class name", () => {
      const { container } = renderUI(
        <Accordion title="Fit" meta={<span>2 applied</span>} className="extra">
          <p>x</p>
        </Accordion>,
      );
      expect(screen.getByRole("button", { name: /Fit/ })).toHaveTextContent("2 applied");
      expect(container.firstChild).toHaveClass("extra");
    });

    it("gives each accordion its own panel id", () => {
      renderUI(
        <>
          <Accordion title="A"><p>a</p></Accordion>
          <Accordion title="B"><p>b</p></Accordion>
        </>,
      );
      const a = screen.getByRole("button", { name: "A" }).getAttribute("aria-controls");
      const b = screen.getByRole("button", { name: "B" }).getAttribute("aria-controls");
      expect(a).not.toBe(b);
    });
  });
});
