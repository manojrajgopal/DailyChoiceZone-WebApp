import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { api, fail, networkError } from "@/test/api";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { useToastStore } from "@/store/toastStore";

import { ActiveBadge, AddButton, ConfigTable, DeleteButton, EditButton, EditModal, saveRow, words } from "./shared";

const toasts = () => useToastStore.getState().toasts.map(({ message, tone }) => ({ message, tone }));

describe("words", () => {
  it.each([
    ["round-robin", "Round robin"],
    ["least-active", "Least active"],
    ["manual", "Manual"],
    ["sla-breached", "Sla breached"],
    ["a-b-c", "A b c"],
    ["already Spaced", "Already Spaced"],
    ["x", "X"],
    ["-leading", " leading"],
    ["", ""],
  ])("turns %j into %j", (input, expected) => {
    expect(words(input)).toBe(expected);
  });
});

describe("saveRow", () => {
  describe("success cases", () => {
    it("POSTs a new row with the admin token, toasts 'added' and reloads", async () => {
      signIn("admin", "adm");
      api.post("/admin/support/config/teams", { id: 9 });
      const reload = vi.fn(async () => undefined);

      await expect(saveRow("teams", { name: "Ops" }, null, reload, "Team")).resolves.toBeNull();

      const request = api.last("POST", "/admin/support/config/teams")!;
      expect(request.body).toEqual({ name: "Ops" });
      expect(request.headers.authorization).toBe("Bearer adm");
      expect(toasts()).toEqual([{ message: "Team added.", tone: "success" }]);
      expect(reload).toHaveBeenCalledOnce();
    });

    it("PUTs an existing row to its id and toasts 'saved'", async () => {
      signIn("admin");
      api.put("/admin/support/config/agents/4", {});
      const reload = vi.fn(async () => undefined);

      await expect(saveRow("agents", { name: "R" }, 4, reload, "Person")).resolves.toBeNull();

      expect(api.last("PUT", "/admin/support/config/agents/4")!.body).toEqual({ name: "R" });
      expect(api.requests("POST")).toHaveLength(0);
      expect(toasts()).toEqual([{ message: "Person saved.", tone: "success" }]);
      expect(reload).toHaveBeenCalledOnce();
    });

    it("treats id 0 as a new row", async () => {
      signIn("admin");
      api.post("/admin/support/config/roles", {});
      await saveRow("roles", {}, 0, vi.fn(async () => undefined), "Role");
      expect(api.requests("POST", "/admin/support/config/roles")).toHaveLength(1);
      expect(toasts()[0]!.message).toBe("Role added.");
    });
  });

  describe("error cases", () => {
    it.each([
      [400, "Name is required."],
      [409, "A team with that name exists."],
      [422, "Email is not valid."],
      [500, "Server exploded."],
    ])("returns the server's %i message and does not reload or toast", async (status, message) => {
      signIn("admin");
      api.post("/admin/support/config/teams", fail(status, message));
      const reload = vi.fn(async () => undefined);
      await expect(saveRow("teams", {}, null, reload, "Team")).resolves.toBe(message);
      expect(reload).not.toHaveBeenCalled();
      expect(toasts()).toEqual([]);
    });

    it("falls back to a generic line when the error has no message", async () => {
      signIn("admin");
      api.post("/admin/support/config/teams", fail(500, ""));
      await expect(saveRow("teams", {}, null, vi.fn(async () => undefined), "Team")).resolves.toBe(
        "That couldn't be saved. Please try again.",
      );
    });

    it("reports a failed reload as the save's error, after the success toast", async () => {
      signIn("admin");
      api.post("/admin/support/config/teams", {});
      const reload = vi.fn(async () => {
        throw new Error("boom");
      });
      await expect(saveRow("teams", {}, null, reload, "Team")).resolves.toBe("That couldn't be saved. Please try again.");
      expect(toasts()).toEqual([{ message: "Team added.", tone: "success" }]);
    });
  });
});

function ModalHarness({ onSave, wide, saveLabel, description }: { onSave: () => Promise<string | null>; wide?: boolean; saveLabel?: string; description?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <EditModal open={open} onOpenChange={setOpen} title="Edit thing" description={description} onSave={onSave} wide={wide} saveLabel={saveLabel}>
        <label>
          Field
          <input />
        </label>
      </EditModal>
    </>
  );
}

describe("EditModal", () => {
  describe("success cases", () => {
    it("shows the title, description and fields, and closes once the save resolves null", async () => {
      const onSave = vi.fn(async () => null);
      const { user } = renderUI(<ModalHarness onSave={onSave} description="Some help" />);
      const dialog = screen.getByRole("dialog", { name: "Edit thing" });
      expect(within(dialog).getByText("Some help")).toBeInTheDocument();
      expect(within(dialog).getByLabelText("Field")).toBeInTheDocument();

      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      expect(onSave).toHaveBeenCalledOnce();
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.getByTestId("state")).toHaveTextContent("closed");
    });

    it("uses a custom save label and the wide layout", () => {
      renderUI(<ModalHarness onSave={vi.fn(async () => null)} wide saveLabel="Publish" />);
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByRole("button", { name: "Publish" })).toBeInTheDocument();
      expect(dialog.className).toContain("max-w-3xl");
    });

    it("is narrow by default", () => {
      renderUI(<ModalHarness onSave={vi.fn(async () => null)} />);
      expect(screen.getByRole("dialog").className).toContain("max-w-xl");
    });

    it("closes on Cancel without saving", async () => {
      const onSave = vi.fn(async () => null);
      const { user } = renderUI(<ModalHarness onSave={onSave} />);
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  describe("error cases", () => {
    it("keeps the modal open with the error line, and disables Cancel while saving", async () => {
      let finish: (value: string | null) => void = () => undefined;
      const onSave = vi.fn(() => new Promise<string | null>((resolve) => { finish = resolve; }));
      const { user } = renderUI(<ModalHarness onSave={onSave} />);

      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

      finish("Name is taken.");
      expect(await screen.findByRole("alert")).toHaveTextContent("Name is taken.");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });

    it("clears the error once the modal is closed and reopened", async () => {
      const { user } = renderUI(<ModalHarness onSave={vi.fn(async () => "Bad")} />);
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Bad");

      await user.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: "Reopen" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("clears a previous error when a retry succeeds", async () => {
      const onSave = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce("First failure").mockResolvedValueOnce(null);
      const { user } = renderUI(<ModalHarness onSave={onSave} />);
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("First failure");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });
  });
});

describe("DeleteButton", () => {
  function setup(reload = vi.fn(async () => undefined)) {
    signIn("admin", "adm");
    const view = renderUI(<DeleteButton list="teams" id={7} name="Payments" reload={reload} />);
    return { ...view, reload };
  }

  describe("success cases", () => {
    it("asks for confirmation, DELETEs the row, toasts, closes and reloads", async () => {
      api.delete("/admin/support/config/teams/7", null);
      const { user, reload } = setup();
      await user.click(screen.getByRole("button", { name: "Delete Payments" }));

      const dialog = screen.getByRole("dialog", { name: "Delete Payments?" });
      expect(dialog).toHaveTextContent("This can't be undone.");
      await user.click(within(dialog).getByRole("button", { name: "Delete" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      const request = api.last("DELETE", "/admin/support/config/teams/7")!;
      expect(request.headers.authorization).toBe("Bearer adm");
      expect(toasts()).toEqual([{ message: "Payments deleted.", tone: "success" }]);
      expect(reload).toHaveBeenCalledOnce();
    });

    it("does nothing when the confirmation is cancelled", async () => {
      const { user, reload } = setup();
      await user.click(screen.getByRole("button", { name: "Delete Payments" }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.requests("DELETE")).toHaveLength(0);
      expect(reload).not.toHaveBeenCalled();
    });

    it("shows the busy state while the delete is in flight", async () => {
      let answer: () => void = () => undefined;
      api.delete("/admin/support/config/teams/7", () => new Promise((resolve) => { answer = () => resolve(null); }));
      const { user } = setup();
      await user.click(screen.getByRole("button", { name: "Delete Payments" }));
      await user.click(screen.getByRole("button", { name: "Delete" }));
      expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      answer();
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });
  });

  describe("error cases", () => {
    it("shows an IN_USE refusal as the API wrote it, and does not reload", async () => {
      api.delete("/admin/support/config/teams/7", fail(409, "Payments still has open tickets — switch it off instead.", "IN_USE"));
      const { user, reload } = setup();
      await user.click(screen.getByRole("button", { name: "Delete Payments" }));
      await user.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(toasts()).toEqual([{ message: "Payments still has open tickets — switch it off instead.", tone: "error" }]);
      expect(reload).not.toHaveBeenCalled();
    });

    it("shows any other API error message", async () => {
      api.delete("/admin/support/config/teams/7", fail(500, "Database unavailable."));
      const { user } = setup();
      await user.click(screen.getByRole("button", { name: "Delete Payments" }));
      await user.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(toasts()).toEqual([{ message: "Database unavailable.", tone: "error" }]));
    });

    it("falls back to a generic line for an error with no message", async () => {
      api.delete("/admin/support/config/teams/7", fail(500, ""));
      const { user } = setup();
      await user.click(screen.getByRole("button", { name: "Delete Payments" }));
      await user.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(toasts()).toEqual([{ message: "Something went wrong. Please try again.", tone: "error" }]));
    });

    it("explains a network failure", async () => {
      api.delete("/admin/support/config/teams/7", networkError());
      const { user } = setup();
      await user.click(screen.getByRole("button", { name: "Delete Payments" }));
      await user.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(toasts()).toHaveLength(1));
      expect(toasts()[0]!.tone).toBe("error");
      expect(toasts()[0]!.message).not.toBe("");
    });
  });
});

describe("small controls", () => {
  it("EditButton is labelled with the row and calls back", async () => {
    const onClick = vi.fn();
    const { user } = renderUI(<EditButton name="Ravi" onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "Edit Ravi" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("AddButton shows its text and calls back", async () => {
    const onClick = vi.fn();
    const { user } = renderUI(<AddButton onClick={onClick}>Add team</AddButton>);
    await user.click(screen.getByRole("button", { name: "Add team" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each([
    [true, "Active"],
    [false, "Off"],
  ])("ActiveBadge(%s) reads %s", (active, label) => {
    renderUI(<ActiveBadge active={active} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe("ConfigTable", () => {
  it("renders column headers, right-aligning those that ask, and the rows", () => {
    renderUI(
      <ConfigTable headers={[{ label: "Name" }, { label: "Open", align: "right" }]}>
        <tr>
          <td>Row one</td>
          <td>3</td>
        </tr>
      </ConfigTable>,
    );
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["Name", "Open"]);
    expect(headers[1]!.className).toContain("text-right");
    expect(headers[0]!.className).not.toContain("text-right");
    expect(screen.getByRole("cell", { name: "Row one" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveStyle({ minWidth: "40rem" });
  });

  it("shows the empty line when given one, with a custom minimum width", () => {
    renderUI(
      <ConfigTable headers={[{ label: "Name" }]} empty="Nothing here." minWidth="20rem">
        {null}
      </ConfigTable>,
    );
    expect(screen.getByText("Nothing here.")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveStyle({ minWidth: "20rem" });
  });

  it("shows no empty line without one", () => {
    const { container } = renderUI(<ConfigTable headers={[{ label: "Name" }]}>{null}</ConfigTable>);
    expect(container.querySelector("p")).toBeNull();
  });
});
