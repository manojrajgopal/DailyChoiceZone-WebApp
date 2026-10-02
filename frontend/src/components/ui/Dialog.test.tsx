import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderUI, screen, waitFor } from "@/test/render";

import { Drawer, Modal } from "./Dialog";

function ControlledModal(props: { description?: string; hideTitle?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open quick view</button>
      <Modal open={open} onOpenChange={setOpen} title="Quick view" {...props}>
        <button type="button">Inside</button>
      </Modal>
    </>
  );
}

describe("Modal", () => {
  describe("open and close", () => {
    it("renders nothing while closed", () => {
      renderUI(<Modal open={false} onOpenChange={vi.fn()} title="Quick view"><p>Body</p></Modal>);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens labelled by its title, auto-focuses inside, and closes from the Close button", async () => {
      const { user } = renderUI(<ControlledModal />);
      const trigger = screen.getByRole("button", { name: "Open quick view" });
      await user.click(trigger);
      const dialog = screen.getByRole("dialog", { name: "Quick view" });
      expect(dialog).toContainElement(screen.getByRole("button", { name: "Inside" }));
      expect(dialog).not.toHaveAttribute("aria-describedby");
      // Radix's own focus-restore-on-close only fires for an opener rendered as
      // `Dialog.Trigger`; this wrapper's `open`/`onOpenChange` API lets any
      // element open it (see Modal/Drawer in ./Dialog.tsx), so there is no
      // `Dialog.Trigger` to restore focus to. Documented current behaviour:
      // focus is NOT returned to the opener. See the final report for details.
      await user.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(trigger).not.toHaveFocus();
    });

    it("closes on Escape", async () => {
      const { user } = renderUI(<ControlledModal />);
      await user.click(screen.getByRole("button", { name: "Open quick view" }));
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("reports onOpenChange(false) when dismissed", async () => {
      const onOpenChange = vi.fn();
      const { user } = renderUI(<Modal open onOpenChange={onOpenChange} title="T"><p>x</p></Modal>);
      await user.keyboard("{Escape}");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe("title and description", () => {
    it("wires the description to the dialog", async () => {
      const { user } = renderUI(<ControlledModal description="Pick a size" />);
      await user.click(screen.getByRole("button", { name: "Open quick view" }));
      expect(screen.getByRole("dialog")).toHaveAccessibleDescription("Pick a size");
    });

    it("hides the title visually but keeps it as the accessible name", async () => {
      const { user } = renderUI(<ControlledModal hideTitle />);
      await user.click(screen.getByRole("button", { name: "Open quick view" }));
      expect(screen.getByText("Quick view").parentElement).toHaveClass("sr-only");
      expect(screen.getByRole("dialog", { name: "Quick view" })).toBeInTheDocument();
    });
  });
});

describe("Drawer", () => {
  it("renders a titled panel with a close button and footer, on the right by default", () => {
    renderUI(
      <Drawer open onOpenChange={vi.fn()} title="Filters" description="Refine" footer={<button type="button">Show 48 results</button>}>
        <p>Options</p>
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    expect(dialog).toHaveClass("right-0");
    expect(dialog).toHaveAccessibleDescription("Refine");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show 48 results" })).toBeInTheDocument();
    expect(screen.getByText("Options")).toBeInTheDocument();
  });

  it.each([
    ["left", "left-0"],
    ["bottom", "bottom-0"],
  ] as const)("anchors to the %s edge", (side, cls) => {
    renderUI(<Drawer open onOpenChange={vi.fn()} title="Menu" side={side}><p>x</p></Drawer>);
    expect(screen.getByRole("dialog")).toHaveClass(cls);
  });

  it("drops the chrome when bare but keeps an sr-only title", () => {
    renderUI(<Drawer open onOpenChange={vi.fn()} title="Admin" bare><p>Sidebar</p></Drawer>);
    expect(screen.getByRole("dialog", { name: "Admin" })).toBeInTheDocument();
    expect(screen.getByText("Admin")).toHaveClass("sr-only");
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("has no footer area when none is given, hides the title when asked, and closes via Close", async () => {
    const onOpenChange = vi.fn();
    const { user } = renderUI(<Drawer open onOpenChange={onOpenChange} title="Bag" hideTitle><p>x</p></Drawer>);
    expect(screen.getByText("Bag").parentElement).toHaveClass("sr-only");
    expect(screen.getByRole("dialog").querySelector(".border-t")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
