import { beforeEach, describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { member, registry, segmentDetail } from "@/test/segments-fixtures";

import { AdminSegmentBuilder } from "./AdminSegmentBuilder";

const optionLabels = (select: HTMLElement) => within(select).getAllByRole("option").map((option) => option.textContent);
const previews = () => api.requests("POST", "/admin/segments/preview");

beforeEach(() => {
  setLocation("/admin/customers/segments/edit");
  api.get("/admin/segments/fields", registry());
  api.post("/admin/segments/preview", { count: 2, items: [member(), member({ customerId: "CUS002", name: "Ravi K" })], page: 1, pageSize: 10, masked: true });
});

async function renderBuilder() {
  const view = renderUI(<AdminSegmentBuilder />);
  await screen.findByRole("heading", { name: "New segment" });
  return view;
}

describe("AdminSegmentBuilder", () => {
  describe("loading and access", () => {
    it("explains a missing segments permission", async () => {
      api.get("/admin/segments/fields", fail(403, "Forbidden", "FORBIDDEN"));
      renderUI(<AdminSegmentBuilder />);
      expect(await screen.findByText("Your role doesn't include segments")).toBeInTheDocument();
    });

    it("offers a retry when the registry doesn't load", async () => {
      api.once("GET", "/admin/segments/fields", fail(500));
      const { user } = renderUI(<AdminSegmentBuilder />);
      await user.click(await screen.findByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("heading", { name: "New segment" })).toBeInTheDocument();
    });

    it("won't edit an archived segment", async () => {
      setLocation("/admin/customers/segments/edit?id=3");
      api.get("/admin/segments/3", segmentDetail({ status: "archived", actions: { edit: false, archive: false, restore: true, recalculate: false, export: true } }));
      renderUI(<AdminSegmentBuilder />);
      expect(await screen.findByText("This segment is archived. Restore it before changing its rules.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to the segment" })).toHaveAttribute("href", "/admin/customers/segments/detail?id=3");
    });
  });

  describe("conditions", () => {
    it("offers the operators of the chosen field's type", async () => {
      const { user } = await renderBuilder();
      await user.click(screen.getByRole("button", { name: "Add condition" }));

      const fieldSelect = screen.getByRole("combobox", { name: "Condition 1 field" });
      // Grouped by the registry's groups.
      expect(within(fieldSelect).getAllByRole("group").map((group) => group.getAttribute("label"))).toEqual(["Profile", "Shopping", "Products"]);

      const operator = () => screen.getByRole("combobox", { name: "Condition 1 operator" });
      expect(optionLabels(operator())).toEqual(["is", "is not", "is more than", "is less than", "is at least", "is at most", "is between"]);

      await user.selectOptions(fieldSelect, "city");
      expect(optionLabels(operator())).toEqual(["is", "is not", "contains", "does not contain", "starts with", "ends with", "is any of", "is none of"]);

      await user.selectOptions(fieldSelect, "lastOrderAt");
      expect(optionLabels(operator())).toContain("is within the last");

      await user.selectOptions(fieldSelect, "hasAbandonedCart");
      expect(optionLabels(operator())).toEqual(["is"]);
      expect(optionLabels(screen.getByRole("combobox", { name: "Condition 1 value" }))).toEqual(["Yes", "No"]);
    });

    it("shows the value input each type and operator needs", async () => {
      const { user } = await renderBuilder();
      await user.click(screen.getByRole("button", { name: "Add condition" }));
      const fieldSelect = screen.getByRole("combobox", { name: "Condition 1 field" });
      const operator = () => screen.getByRole("combobox", { name: "Condition 1 operator" });

      // money: an amount with the ₹ unit, and the field's description
      await user.selectOptions(fieldSelect, "totalSpend");
      expect(screen.getByRole("spinbutton", { name: "Condition 1 value" })).toHaveAttribute("step", "0.01");
      expect(screen.getByText("₹")).toBeInTheDocument();
      expect(screen.getByText("Net of refunds; cancelled and returned orders excluded")).toBeInTheDocument();

      // between: two inputs
      await user.selectOptions(operator(), "between");
      expect(screen.getByRole("spinbutton", { name: "Condition 1 from" })).toBeInTheDocument();
      expect(screen.getByRole("spinbutton", { name: "Condition 1 to" })).toBeInTheDocument();

      // date: a date picker; within-last-days: a number of days
      await user.selectOptions(fieldSelect, "lastOrderAt");
      await user.selectOptions(operator(), "before");
      expect(screen.getByLabelText("Condition 1 value")).toHaveAttribute("type", "date");
      await user.selectOptions(operator(), "within-last-days");
      expect(screen.getByRole("spinbutton", { name: "Condition 1 days" })).toBeInTheDocument();
      expect(screen.getByText("days")).toBeInTheDocument();

      // enum: a select, or a checklist for "is any of"
      await user.selectOptions(fieldSelect, "rfmLabel");
      expect(optionLabels(screen.getByRole("combobox", { name: "Condition 1 value" }))).toEqual(["Choose…", "Champions", "At risk", "Lost"]);
      await user.selectOptions(operator(), "in");
      const checklist = screen.getByRole("group", { name: "Condition 1 values" });
      expect(within(checklist).getAllByRole("checkbox")).toHaveLength(3);

      // list with options: a checklist of them
      await user.selectOptions(fieldSelect, "purchasedCategories");
      await user.selectOptions(operator(), "in");
      expect(within(screen.getByRole("group", { name: "Condition 1 values" })).getByLabelText("Kurtas")).toBeInTheDocument();

      // list without options: ids, comma separated, shown as tags
      await user.selectOptions(fieldSelect, "purchasedProducts");
      await user.selectOptions(operator(), "in");
      await user.type(screen.getByRole("textbox", { name: "Condition 1 values" }), "PRD001, PRD002,");
      expect(within(screen.getByRole("list", { name: "Condition 1 values chosen" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["PRD001", "PRD002"]);

      // string "is any of": comma separated too
      await user.selectOptions(fieldSelect, "city");
      await user.selectOptions(operator(), "in");
      expect(screen.getByRole("textbox", { name: "Condition 1 values" })).toHaveValue("");
    });

    it("adds and removes conditions and groups", async () => {
      const { user } = await renderBuilder();
      expect(screen.getByText(/No conditions yet/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Add condition" }));
      await user.click(screen.getByRole("button", { name: "Add condition" }));
      expect(screen.getByRole("combobox", { name: "Condition 2 field" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Remove condition 1" }));
      expect(screen.queryByRole("combobox", { name: "Condition 2 field" })).not.toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Condition 1 field" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Add group" }));
      expect(screen.getByRole("radiogroup", { name: "Group 1 match" })).toBeInTheDocument();
      // A new group matches "any" of its own conditions by default.
      expect(within(screen.getByRole("radiogroup", { name: "Group 1 match" })).getByRole("radio", { name: "Any (OR)" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("combobox", { name: "Group 1 condition 1 field" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Add condition to group 1" }));
      expect(screen.getByRole("combobox", { name: "Group 1 condition 2 field" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Remove group 1 condition 1" }));
      expect(screen.queryByRole("combobox", { name: "Group 1 condition 2 field" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Remove group 1" }));
      expect(screen.queryByRole("radiogroup", { name: "Group 1 match" })).not.toBeInTheDocument();
      expect(screen.getByText("1 of 30 conditions. One level of groups; an empty list matches every customer.")).toBeInTheDocument();
    });
  });

  describe("live preview", () => {
    it("counts the matches a moment after the rules change, and lists the first customers", async () => {
      const { user } = await renderBuilder();
      // The empty rule list is previewed too: it matches every customer.
      await waitFor(() => expect(previews()).toHaveLength(1));
      expect(previews()[0]!.body).toEqual({ match: "all", rules: [], page: 1, pageSize: 10 });
      expect(await screen.findByTestId("preview-count")).toHaveTextContent("2");
      expect(screen.getByRole("table", { name: "Matching customers" })).toHaveTextContent("a••••@example.com · 987•••00001");
      expect(screen.getByText(/Contact details are masked/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Add condition" }));
      // An unfinished condition isn't previewed.
      expect(screen.getByText("Finish the conditions to see who matches.")).toBeInTheDocument();

      await user.selectOptions(screen.getByRole("combobox", { name: "Condition 1 operator" }), "gte");
      await user.type(screen.getByRole("spinbutton", { name: "Condition 1 value" }), "25");
      // Debounced: typing "2" then "5" sends one request, for 25.
      expect(previews()).toHaveLength(1);
      await waitFor(() => expect(previews()).toHaveLength(2), { timeout: 2000 });
      expect(previews()[1]!.body.rules).toEqual([{ field: "totalOrders", operator: "gte", value: 25 }]);
    });

    it("shows the server's explanation when the rules are refused", async () => {
      api.post("/admin/segments/preview", fail(422, "Total orders: use a whole number.", "INVALID_SEGMENT_RULE", { path: "rules.0" }));
      await renderBuilder();
      expect(await screen.findByText("Total orders: use a whole number.")).toBeInTheDocument();
    });
  });

  describe("saving", () => {
    it("checks the name and every condition before sending anything", async () => {
      const { user } = await renderBuilder();
      await user.click(screen.getByRole("button", { name: "Add condition" }));
      await user.click(screen.getByRole("button", { name: "Create segment" }));
      expect(screen.getByText("Give the segment a name.")).toBeInTheDocument();
      expect(screen.getByText("Enter a value.")).toBeInTheDocument();

      await user.type(screen.getByLabelText(/^Name/), "Big");
      await user.selectOptions(screen.getByRole("combobox", { name: "Condition 1 operator" }), "between");
      await user.type(screen.getByRole("spinbutton", { name: "Condition 1 from" }), "9");
      await user.type(screen.getByRole("spinbutton", { name: "Condition 1 to" }), "2");
      expect(screen.getByText("Put the lower value first.")).toBeInTheDocument();
      expect(api.last("POST", "/admin/segments")).toBeUndefined();
    });

    it("creates the segment with the rules in the API's shape, then opens it", async () => {
      api.post("/admin/segments", segmentDetail({ id: 9, name: "Big spenders" }));
      const { user } = await renderBuilder();

      await user.type(screen.getByLabelText(/^Name/), "  Big spenders ");
      await user.type(screen.getByLabelText("Description"), "Spent a lot");
      await user.click(within(screen.getByRole("radiogroup", { name: "Match conditions" })).getByRole("radio", { name: "Any (OR)" }));

      await user.click(screen.getByRole("button", { name: "Add condition" }));
      await user.selectOptions(screen.getByRole("combobox", { name: "Condition 1 field" }), "totalSpend");
      await user.selectOptions(screen.getByRole("combobox", { name: "Condition 1 operator" }), "gte");
      await user.type(screen.getByRole("spinbutton", { name: "Condition 1 value" }), "10000.5");

      await user.click(screen.getByRole("button", { name: "Add group" }));
      await user.click(within(screen.getByRole("radiogroup", { name: "Group 1 match" })).getByRole("radio", { name: "All (AND)" }));
      await user.selectOptions(screen.getByRole("combobox", { name: "Group 1 condition 1 field" }), "city");
      await user.selectOptions(screen.getByRole("combobox", { name: "Group 1 condition 1 operator" }), "in");
      await user.type(screen.getByRole("textbox", { name: "Group 1 condition 1 values" }), "Bengaluru, Mysuru");
      await user.click(screen.getByRole("button", { name: "Add condition to group 1" }));
      await user.selectOptions(screen.getByRole("combobox", { name: "Group 1 condition 2 field" }), "hasAbandonedCart");
      await user.selectOptions(screen.getByRole("combobox", { name: "Group 1 condition 2 value" }), "false");

      await user.click(screen.getByRole("button", { name: "Create segment" }));
      await waitFor(() => expect(api.last("POST", "/admin/segments")).toBeTruthy());
      expect(api.last("POST", "/admin/segments")!.body).toEqual({
        name: "Big spenders",
        description: "Spent a lot",
        match: "any",
        rules: [
          { field: "totalSpend", operator: "gte", value: 10000.5 },
          {
            match: "all",
            rules: [
              { field: "city", operator: "in", value: ["Bengaluru", "Mysuru"] },
              { field: "hasAbandonedCart", operator: "equals", value: false },
            ],
          },
        ],
      });
      await waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/customers/segments/detail?id=9"));
    });

    it("shows the server's rule error on the condition it names", async () => {
      api.post("/admin/segments", fail(422, "Total spend: “between” needs two amounts, the lower first.", "INVALID_SEGMENT_RULE", { path: "rules.0", field: "totalSpend", operator: "between" }));
      const { user } = await renderBuilder();
      await user.type(screen.getByLabelText(/^Name/), "Odd");
      await user.click(screen.getByRole("button", { name: "Add condition" }));
      await user.type(screen.getByRole("spinbutton", { name: "Condition 1 value" }), "3");
      await user.click(screen.getByRole("button", { name: "Create segment" }));
      const alerts = await screen.findAllByText("Total spend: “between” needs two amounts, the lower first.");
      // Once in the banner, once on the row.
      expect(alerts).toHaveLength(2);
      expect(router.push).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Create segment" })).not.toBeDisabled();
    });

    it("shows a taken name under the name field", async () => {
      api.post("/admin/segments", fail(409, "Another segment is already called VIP.", "SEGMENT_NAME_TAKEN"));
      const { user } = await renderBuilder();
      await user.type(screen.getByLabelText(/^Name/), "VIP");
      await user.click(screen.getByRole("button", { name: "Create segment" }));
      expect(await screen.findByText("Another segment is already called VIP.")).toBeInTheDocument();
      expect(screen.getByLabelText(/^Name/)).toHaveAttribute("aria-invalid", "true");
    });

    it("hides a server crash behind a plain message", async () => {
      api.post("/admin/segments", fail(500, "sqlalchemy.exc.OperationalError"));
      const { user } = await renderBuilder();
      await user.type(screen.getByLabelText(/^Name/), "Crash");
      await user.click(screen.getByRole("button", { name: "Create segment" }));
      expect(await screen.findByText("The segment wasn't saved. Please try again.")).toBeInTheDocument();
      expect(screen.queryByText(/sqlalchemy/)).not.toBeInTheDocument();
    });

    it("edits an existing segment and goes back to it", async () => {
      setLocation("/admin/customers/segments/edit?id=3");
      api.get("/admin/segments/3", segmentDetail());
      api.put("/admin/segments/3", segmentDetail({ name: "VIP+" }));
      const { user } = renderUI(<AdminSegmentBuilder />);
      expect(await screen.findByRole("heading", { name: "Edit VIP" })).toBeInTheDocument();
      expect(screen.getByLabelText(/^Name/)).toHaveValue("VIP");
      expect(screen.getByRole("combobox", { name: "Condition 1 field" })).toHaveValue("totalSpend");
      expect(screen.getByRole("spinbutton", { name: "Condition 1 value" })).toHaveValue(25000);
      expect(screen.getByRole("textbox", { name: "Group 1 condition 1 values" })).toHaveValue("Bengaluru, Mysuru");
      expect(screen.getByRole("spinbutton", { name: "Group 1 condition 2 days" })).toHaveValue(180);
      expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/admin/customers/segments/detail?id=3");

      await user.clear(screen.getByLabelText(/^Name/));
      await user.type(screen.getByLabelText(/^Name/), "VIP+");
      await user.click(screen.getByRole("button", { name: "Save segment" }));
      await waitFor(() => expect(api.last("PUT", "/admin/segments/3")).toBeTruthy());
      expect(api.last("PUT", "/admin/segments/3")!.body).toEqual({
        name: "VIP+",
        description: "Big spenders who ordered lately",
        match: "all",
        rules: segmentDetail().rules,
      });
      await waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/customers/segments/detail?id=3"));
    });
  });
});
