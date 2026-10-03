import { describe, expect, it, vi } from "vitest";

import type { SizeGuide } from "@/services/discoveryService";
import { renderUI, screen, waitFor, within } from "@/test/render";

import { SizeGuideButton } from "./SizeGuideDialog";

function guide(overrides: Partial<SizeGuide> = {}): SizeGuide {
  return {
    id: "SZG001",
    name: "Men's T-Shirt",
    kind: "clothing",
    description: "Body measurements.",
    unit: "cm",
    storedUnit: "cm",
    units: ["cm", "in"],
    columns: [
      { key: "chest", label: "Chest", type: "measurement" },
      { key: "uk", label: "UK", type: "text" },
    ],
    rows: [
      { size: "M", values: { chest: { min: 92, max: 97 }, uk: "38" }, stored: { chest: { min: 92, max: 97 } }, offered: true },
      { size: "L", values: { chest: { min: 98, max: 103 }, uk: "40" }, stored: { chest: { min: 98, max: 103 } }, offered: true },
      { size: "XXL", values: { chest: { min: 110 }, uk: "44" }, stored: { chest: { min: 110 } }, offered: false },
    ],
    instructions: [{ title: "Chest", body: "Around the fullest part of your chest.", column: "chest" }],
    notes: "Between sizes? Size up.",
    ...overrides,
  };
}

async function open(props: Partial<Parameters<typeof SizeGuideButton>[0]> = {}) {
  const view = renderUI(<SizeGuideButton guide={guide()} {...props} />);
  await view.user.click(screen.getByRole("button", { name: "Size guide" }));
  return view;
}

describe("SizeGuideButton", () => {
  it("opens the guide in an accessible dialog with a real table", async () => {
    await open();
    const dialog = screen.getByRole("dialog", { name: "Men's T-Shirt" });
    const table = within(dialog).getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Chest" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: /^M/ })).toBeInTheDocument();
    expect(within(table).getByText("92–97 cm")).toBeInTheDocument();
    expect(within(table).getByText("38")).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "How to measure" })).toBeInTheDocument();
    expect(within(dialog).getByText("Around the fullest part of your chest.")).toBeInTheDocument();
    expect(within(dialog).getByText("Between sizes? Size up.")).toBeInTheDocument();
  });

  it("switches to inches, converted from the stored values, and back", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Inches" }));
    expect(screen.getByRole("button", { name: "Inches" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("36.2–38.2 in")).toBeInTheDocument();
    expect(screen.getByText("43.3 in")).toBeInTheDocument();
    // Text columns are never converted.
    expect(screen.getByText("38")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Centimetres" }));
    expect(screen.getByText("92–97 cm")).toBeInTheDocument();
    expect(localStorage.getItem("dcz:size-unit")).toBe("cm");
  });

  it("remembers the unit on this device", async () => {
    localStorage.setItem("dcz:size-unit", "in");
    await open();
    expect(screen.getByText("36.2–38.2 in")).toBeInTheDocument();
  });

  it("chooses a size from its row and closes", async () => {
    const onSelectSize = vi.fn();
    const { user } = await open({ onSelectSize, selectedSize: "M" });
    expect(screen.getByRole("button", { name: "Choose size M" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Choose size L" }));
    expect(onSelectSize).toHaveBeenCalledWith("L");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("marks a size the product isn't sold in and offers no button for it", async () => {
    await open({ onSelectSize: vi.fn() });
    expect(screen.getByText("(not available)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose size XXL" })).not.toBeInTheDocument();
  });

  it("closes with Escape and returns focus to the button", async () => {
    const { user } = await open();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Size guide" })).toHaveFocus());
  });

  it("offers no unit switch for a guide with nothing to convert", async () => {
    await open({ guide: guide({ columns: [{ key: "uk", label: "UK", type: "text" }],
      rows: [{ size: "7", values: { uk: "7" }, stored: {}, offered: true }] }) });
    expect(screen.queryByRole("button", { name: "Inches" })).not.toBeInTheDocument();
  });
});
