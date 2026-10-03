"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { useConfirmedCustomer } from "@/hooks/useSession";
import { cn } from "@/lib/utils/cn";
import { PINCODE_PATTERN } from "@/services/deliveryService";
import { checkCartAvailability, type CartAvailability } from "@/services/discoveryService";

/**
 * Every bag line against the delivery pincode — so checkout can say *which*
 * item is the problem ("the glass lamp isn't sent to Assam") rather than
 * failing the whole order at the last step. Signed-in bags only: a guest signs
 * in before checkout. Placing the order checks all of it again on the server.
 */
export function useCartAvailability(pincode: string | null | undefined, version = 0) {
  const signedIn = useConfirmedCustomer();
  const code = (pincode ?? "").trim();
  const [state, setState] = useState<{ key: string; result: CartAvailability | null }>({ key: "", result: null });
  const key = `${code}|${version}`;

  useEffect(() => {
    if (!signedIn || !PINCODE_PATTERN.test(code)) return;
    let live = true;
    const timer = setTimeout(() => {
      checkCartAvailability(code)
        .then((result) => live && setState({ key, result }))
        // Unknown is not "unavailable": the server decides at placement.
        .catch(() => live && setState({ key, result: null }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [signedIn, code, key]);

  if (!signedIn || !PINCODE_PATTERN.test(code)) return { result: null, loading: false };
  return { result: state.key === key ? state.result : null, loading: state.key !== key };
}

export function CartAvailabilityNotice({ result, className }: { result: CartAvailability | null; className?: string }) {
  if (!result || !result.serviceable || result.allAvailable) return null;
  const problems = result.lines.filter((line) => !line.available);
  return (
    <div role="alert" className={cn("rounded-card border border-danger/30 bg-danger-bg p-3.5 text-sm text-danger", className)}>
      <p className="flex items-start gap-2 font-medium">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        {problems.length === 1
          ? `One item in your bag can't be delivered to ${result.pincode}:`
          : `${problems.length} items in your bag can't be delivered to ${result.pincode}:`}
      </p>
      <ul className="mt-1.5 flex flex-col gap-1 pl-6 text-xs">
        {problems.map((line) => (
          <li key={line.lineId}>
            <span className="font-medium">{line.name}</span> — {line.message}
          </li>
        ))}
      </ul>
      <p className="mt-2 pl-6 text-xs">Remove {problems.length === 1 ? "it" : "them"} from your bag, or deliver somewhere else.</p>
    </div>
  );
}
