"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";

import type { Product } from "@/types";

import { TryOnDialog } from "@/components/tryon/TryOnDialog";
import { useTryOnState } from "@/components/tryon/useTryOn";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";

/**
 * "Try it on" for a product that supports it; a quiet "coming soon" for one
 * whose kind of item is announced; nothing at all otherwise. Whether the
 * shopper may use it (plan, allowance) is answered inside the dialog, by the
 * server.
 */
export function TryOnButton({
  product,
  color,
  size,
  onAddToBag,
  className,
  fullWidth,
}: {
  product: Pick<Product, "id" | "name" | "category" | "subcategory" | "colors" | "sizes">;
  color: string | null;
  size: string | null;
  onAddToBag?: () => void;
  className?: string;
  fullWidth?: boolean;
}) {
  const { state, capability } = useTryOnState(product);
  const [open, setOpen] = useState(false);

  if (state === "coming_soon") {
    return (
      <p className={cn("flex items-center gap-1.5 text-xs text-ink-500", className)}>
        <Sparkles className="h-3.5 w-3.5 text-copper-500" aria-hidden="true" />
        Virtual try-on for {capability?.name.toLowerCase() ?? "this item"} is coming soon
      </p>
    );
  }
  if (state !== "available") return null;

  return (
    <>
      <Button variant="secondary" size="lg" onClick={() => setOpen(true)} fullWidth={fullWidth} className={className}>
        <Sparkles className="h-4 w-4" aria-hidden="true" /> Try it on
      </Button>
      {open ? (
        <TryOnDialog
          open={open}
          onOpenChange={setOpen}
          product={product}
          color={color}
          size={size}
          onAddToBag={
            onAddToBag
              ? () => {
                  onAddToBag();
                  setOpen(false);
                }
              : undefined
          }
        />
      ) : null}
    </>
  );
}

/** A small "Try on" badge for product cards. */
export function TryOnBadge({ product }: { product: Pick<Product, "id" | "category" | "subcategory"> }) {
  const { state } = useTryOnState(product);
  if (state !== "available") return null;
  return (
    <Badge tone="neutral" className="gap-1">
      <Sparkles className="h-3 w-3" aria-hidden="true" /> Try on
    </Badge>
  );
}
