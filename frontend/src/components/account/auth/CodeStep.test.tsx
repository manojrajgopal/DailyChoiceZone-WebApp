import { describe, expect, it, vi } from "vitest";

import type { IssuedOtp } from "@/types/identity";

import { ApiError } from "@/services/api/client";
import { act, renderUI, screen, waitFor } from "@/test/render";

import { CodeStep } from "./CodeStep";

function issued(overrides: Partial<IssuedOtp> = {}): IssuedOtp {
  return { challengeId: "ch1", channel: "sms", destination: "+91 ******3210", expiresIn: 300, resendIn: 0, length: 6, ...overrides };
}

const codeBox = () => screen.getByLabelText(/^One-time code/) as HTMLInputElement;

describe("CodeStep", () => {
  it("says where the code went and focuses a one-time-code box", () => {
    renderUI(<CodeStep issued={issued()} onVerify={vi.fn()} onResend={vi.fn()} />);
    expect(screen.getByText("+91 ******3210")).toBeInTheDocument();
    expect(codeBox()).toHaveFocus();
    expect(codeBox()).toHaveAttribute("autocomplete", "one-time-code");
    expect(codeBox()).toHaveAttribute("inputmode", "numeric");
  });

  it("keeps only digits, up to the code's length, and checks it when complete", async () => {
    const onVerify = vi.fn().mockResolvedValue(undefined);
    const { user } = renderUI(<CodeStep issued={issued({ length: 4 })} onVerify={onVerify} onResend={vi.fn()} />);
    await user.type(codeBox(), "1a2 3");
    expect(codeBox()).toHaveValue("123");
    expect(onVerify).not.toHaveBeenCalled();
    await user.type(codeBox(), "49");
    expect(codeBox()).toHaveValue("1234");
    await waitFor(() => expect(onVerify).toHaveBeenCalledWith("ch1", "1234"));
    expect(onVerify).toHaveBeenCalledTimes(1);
  });

  it("accepts a pasted message and pulls the code out of it", async () => {
    const onVerify = vi.fn().mockResolvedValue(undefined);
    const { user } = renderUI(<CodeStep issued={issued()} onVerify={onVerify} onResend={vi.fn()} />);
    await user.click(codeBox());
    await user.paste("Your code is 123 456");
    expect(codeBox()).toHaveValue("123456");
    await waitFor(() => expect(onVerify).toHaveBeenCalledWith("ch1", "123456"));
  });

  it("says how many tries are left after a wrong code", async () => {
    const onVerify = vi.fn().mockRejectedValue(new ApiError("Wrong", 400, "OTP_INCORRECT", { attemptsLeft: 2 }));
    const { user } = renderUI(<CodeStep issued={issued()} onVerify={onVerify} onResend={vi.fn()} />);
    await user.type(codeBox(), "000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't right. 2 tries left.");
    // Still usable: correct it and try again.
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("asks for a new code once this one is locked", async () => {
    const onVerify = vi.fn().mockRejectedValue(new ApiError("Too many wrong attempts. Request a new code.", 400, "OTP_LOCKED"));
    const { user } = renderUI(<CodeStep issued={issued()} onVerify={onVerify} onResend={vi.fn()} />);
    await user.type(codeBox(), "000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many wrong attempts. Request a new code.");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send a new code" })).toBeEnabled();
  });

  it("sends a new code and starts again with it", async () => {
    const onVerify = vi.fn().mockRejectedValueOnce(new ApiError("Expired", 400, "OTP_EXPIRED")).mockResolvedValue(undefined);
    const onResend = vi.fn().mockResolvedValue(issued({ challengeId: "ch2", resendIn: 0 }));
    const { user } = renderUI(<CodeStep issued={issued()} onVerify={onVerify} onResend={onResend} />);
    await user.type(codeBox(), "111111");
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Send a new code" }));
    expect(await screen.findByText("We've sent a new code to +91 ******3210.")).toBeInTheDocument();
    expect(codeBox()).toHaveValue("");
    expect(codeBox()).toHaveFocus();
    await user.type(codeBox(), "222222");
    await waitFor(() => expect(onVerify).toHaveBeenLastCalledWith("ch2", "222222"));
  });

  it("counts down to the next code from resendIn", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderUI(<CodeStep issued={issued({ resendIn: 30 })} onVerify={vi.fn()} onResend={vi.fn()} />);
    expect(screen.getByText("You can ask for a new code in 0:30")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send a new code" })).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(screen.getByRole("button", { name: "Send a new code" })).toBeInTheDocument();
    expect(screen.getByText("You can ask for a new code now.")).toBeInTheDocument();
  });

  it("waits as long as the API says when a new code is asked for too soon", async () => {
    const onResend = vi.fn().mockRejectedValue(
      new ApiError("Please wait 20 seconds before asking for another code.", 429, "OTP_RESEND_WAIT", { retryAfter: 20 }),
    );
    const { user } = renderUI(<CodeStep issued={issued()} onVerify={vi.fn()} onResend={onResend} />);
    await user.click(screen.getByRole("button", { name: "Send a new code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Please wait 20 seconds");
    expect(screen.getByText("You can ask for a new code in 0:20")).toBeInTheDocument();
  });

  it("calls the code expired when its time runs out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderUI(<CodeStep issued={issued({ expiresIn: 60 })} onVerify={vi.fn()} onResend={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("This code has expired. Ask for a new one.");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("does not check the code by itself when other fields are still to fill", async () => {
    const onVerify = vi.fn().mockResolvedValue(undefined);
    const { user } = renderUI(
      <CodeStep issued={issued()} onVerify={onVerify} onResend={vi.fn()} autoSubmit={false} submitLabel="Set password" />,
    );
    await user.type(codeBox(), "123456");
    expect(onVerify).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(onVerify).toHaveBeenCalledWith("ch1", "123456");
  });
});
