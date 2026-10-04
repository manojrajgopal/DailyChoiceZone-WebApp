import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { api } from "@/test/api";
import { idPreview, lookupBackend } from "@/test/lookup-fixtures";
import { renderUI, screen, waitFor, within } from "@/test/render";
import type { AdminCoupon } from "@/types/admin";

import { CouponAudienceFields } from "./CouponAudienceFields";

// A coupon's customers and segment are chosen by ID (docs/id-lookup.md): no
// customer list is loaded, and names, emails and phones find nothing.

function Harness({ initial, onChange }: { initial: Partial<AdminCoupon>; onChange: (coupon: AdminCoupon) => void }) {
  const [coupon, setCoupon] = useState({ code: "WELCOME", ...initial } as AdminCoupon);
  return (
    <CouponAudienceFields
      coupon={coupon}
      onChange={(next) => {
        setCoupon(next);
        onChange(next);
      }}
    />
  );
}

describe("CouponAudienceFields", () => {
  it("adds customers by Customer ID, without loading every customer", async () => {
    lookupBackend("customer", [
      idPreview("customer", "CUS001", { title: "Asha Rao", subtitle: "asha@example.com" }),
      idPreview("customer", "CUS0010", { title: "Ravi K" }),
    ]);
    const onChange = vi.fn();
    const { user } = renderUI(<Harness initial={{ audience: "selected", customerIds: [] }} onChange={onChange} />);
    expect(screen.getByText("Pick at least one customer.")).toBeInTheDocument();

    const field = screen.getByRole("combobox", { name: "Customer ID" });
    await user.type(field, "Asha");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, "CUS001");
    expect(await screen.findByRole("option", { name: "CUS0010" })).toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "CUS001" }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ customerIds: ["CUS001"] }));
    expect(within(screen.getByRole("list", { name: "Chosen Customer IDs" })).getByText("CUS001")).toBeInTheDocument();
    expect(api.requests("GET", /\/admin\/customers/)).toHaveLength(0);
  });

  it("removes a chosen customer", async () => {
    const onChange = vi.fn();
    const { user } = renderUI(<Harness initial={{ audience: "selected", customerIds: ["CUS001", "CUS002"] }} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Remove Customer ID CUS001" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ customerIds: ["CUS002"] }));
  });

  it("takes the segment by Segment ID and stores it as a number", async () => {
    lookupBackend("segment", [idPreview("segment", "3", { title: "VIP" }), idPreview("segment", "31", { title: "Lapsed" })]);
    const onChange = vi.fn();
    const { user } = renderUI(<Harness initial={{ audience: "segment", segmentId: null }} onChange={onChange} />);
    expect(screen.getByText("Choose a segment.")).toBeInTheDocument();
    expect(api.requests("GET", "/admin/segments")).toHaveLength(0);

    const field = screen.getByRole("combobox", { name: "Segment" });
    await user.type(field, "VIP");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, "3");
    await user.click(await screen.findByRole("option", { name: "3" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ segmentId: 3 })));
    expect(await screen.findByText("VIP")).toBeInTheDocument();
    expect(screen.queryByText("Choose a segment.")).not.toBeInTheDocument();
  });
});
