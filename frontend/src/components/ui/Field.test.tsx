import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderUI, screen } from "@/test/render";

import { Checkbox, Input, Radio, Select, Textarea } from "./Field";

describe("Input", () => {
  describe("labelling", () => {
    it("associates the label with the input and marks required fields", () => {
      renderUI(<Input label="Email" required name="email" />);
      const input = screen.getByRole("textbox", { name: /Email/ });
      expect(input).toBeRequired();
      expect(input).toHaveAttribute("name", "email");
      expect(screen.getByText("*")).toHaveAttribute("aria-hidden", "true");
      expect(input).not.toHaveAttribute("aria-invalid");
      expect(input).not.toHaveAttribute("aria-describedby");
    });

    it("renders with no label at all", () => {
      const { container } = renderUI(<Input placeholder="Search" />);
      expect(container.querySelector("label")).toBeNull();
      expect(screen.getByPlaceholderText("Search")).toBeInTheDocument();
    });
  });

  describe("hint and error", () => {
    it("describes the input by its hint", () => {
      renderUI(<Input label="Phone" hint="10 digits" />);
      expect(screen.getByRole("textbox", { name: "Phone" })).toHaveAccessibleDescription("10 digits");
    });

    it("replaces the hint with an alert error and flags the input as invalid", () => {
      renderUI(<Input label="Phone" hint="10 digits" error="Enter a valid number" />);
      const input = screen.getByRole("textbox", { name: "Phone" });
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid number");
      expect(screen.queryByText("10 digits")).not.toBeInTheDocument();
      // The hint id is still referenced, the error comes first.
      expect(input.getAttribute("aria-describedby")!.split(" ")).toHaveLength(2);
      expect(input).toHaveAccessibleDescription(/Enter a valid number/);
      expect(input).toHaveClass("border-danger");
    });
  });

  describe("interaction", () => {
    it("accepts typing, forwards the ref and the input class name", async () => {
      const ref = createRef<HTMLInputElement>();
      const onChange = vi.fn();
      const { user } = renderUI(<Input ref={ref} label="Name" inputClassName="tracking-wide" className="wrap" onChange={onChange} />);
      const input = screen.getByRole("textbox", { name: "Name" });
      await user.type(input, "Asha");
      expect(input).toHaveValue("Asha");
      expect(onChange).toHaveBeenCalledTimes(4);
      expect(ref.current).toBe(input);
      expect(input).toHaveClass("tracking-wide");
      expect(input.parentElement).toHaveClass("wrap");
    });

    it("is disabled when asked", () => {
      renderUI(<Input label="Code" disabled />);
      expect(screen.getByRole("textbox", { name: "Code" })).toBeDisabled();
    });
  });
});

describe("Textarea", () => {
  it("defaults to four rows and shows errors", async () => {
    const ref = createRef<HTMLTextAreaElement>();
    const { user } = renderUI(<Textarea ref={ref} label="Message" error="Too short" required />);
    const area = screen.getByRole("textbox", { name: /Message/ });
    expect(area).toHaveAttribute("rows", "4");
    expect(area).toHaveAttribute("aria-invalid", "true");
    expect(area).toBeRequired();
    expect(screen.getByRole("alert")).toHaveTextContent("Too short");
    await user.type(area, "Hi");
    expect(ref.current).toHaveValue("Hi");
  });

  it("honours a custom row count and a hint", () => {
    renderUI(<Textarea label="Notes" rows={2} hint="Optional" />);
    const area = screen.getByRole("textbox", { name: "Notes" });
    expect(area).toHaveAttribute("rows", "2");
    expect(area).not.toHaveAttribute("aria-invalid");
    expect(area).toHaveAccessibleDescription("Optional");
  });
});

describe("Select", () => {
  const options = [
    { value: "relevance", label: "Relevance" },
    { value: "price-asc", label: "Price: low to high" },
  ];

  it("renders its options and reports a change", async () => {
    const onChange = vi.fn();
    const { user } = renderUI(<Select label="Sort" options={options} onChange={onChange} selectClassName="w-40" />);
    const select = screen.getByRole("combobox", { name: "Sort" });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await user.selectOptions(select, "price-asc");
    expect(select).toHaveValue("price-asc");
    expect(onChange).toHaveBeenCalledOnce();
    expect(select).toHaveClass("w-40");
    expect(select).not.toHaveAttribute("aria-invalid");
  });

  it("flags an error", () => {
    const ref = createRef<HTMLSelectElement>();
    renderUI(<Select ref={ref} label="State" options={[]} error="Choose a state" required />);
    const select = screen.getByRole("combobox", { name: /State/ });
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toBeRequired();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a state");
    expect(ref.current).toBe(select);
  });
});

describe("Checkbox", () => {
  it("toggles through its label and shows a count", async () => {
    const onChange = vi.fn();
    const { user } = renderUI(<Checkbox label="Sneakers" count={12} onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: /Sneakers/ });
    expect(screen.getByText("12")).toBeInTheDocument();
    await user.click(screen.getByText("Sneakers"));
    expect(box).toBeChecked();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("shows a count of zero but no count when undefined", () => {
    const { rerender } = renderUI(<Checkbox label="Boots" count={0} />);
    expect(screen.getByText("0")).toBeInTheDocument();
    rerender(<Checkbox label="Boots" />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("does not toggle when disabled, and forwards the ref", async () => {
    const ref = createRef<HTMLInputElement>();
    const { user } = renderUI(<Checkbox ref={ref} label="Sold out" disabled className="c" />);
    const box = screen.getByRole("checkbox", { name: "Sold out" });
    await user.click(box);
    expect(box).not.toBeChecked();
    expect(ref.current).toBe(box);
    expect(box.closest("label")).toHaveClass("c");
  });
});

describe("Radio", () => {
  it("selects one of a group and shows its description", async () => {
    const ref = createRef<HTMLInputElement>();
    const { user } = renderUI(
      <>
        <Radio ref={ref} name="ship" value="std" label="Standard" description="3-5 days" />
        <Radio name="ship" value="exp" label="Express" className="r" />
      </>,
    );
    expect(screen.getByText("3-5 days")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Express/ }));
    expect(screen.getByRole("radio", { name: /Express/ })).toBeChecked();
    await user.click(screen.getByText("Standard"));
    expect(screen.getByRole("radio", { name: /Standard/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Express/ })).not.toBeChecked();
    expect(ref.current).toBe(screen.getByRole("radio", { name: /Standard/ }));
    expect(screen.getByRole("radio", { name: /Express/ }).closest("label")).toHaveClass("r");
  });
});
