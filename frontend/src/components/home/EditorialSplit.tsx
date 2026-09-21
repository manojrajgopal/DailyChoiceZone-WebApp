import Image from "next/image";

import { ButtonLink } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";

export interface EditorialSplitProps {
  title: string;
  body: string;
  image: string;
  ctaLabel: string;
  ctaHref: string;
  align?: "left" | "right";
}

/**
 * A two-up editorial break between product rails.
 *
 * Not a hero — it sits well down the page, after the shopper has already seen
 * products, and gives the eye somewhere to rest between grids.
 */
export function EditorialSplit({
  title,
  body,
  image,
  ctaLabel,
  ctaHref,
  align = "right",
}: EditorialSplitProps) {
  return (
    <div className="grid items-stretch gap-0 overflow-hidden rounded-card bg-cream-deep lg:grid-cols-2">
      <div
        className={cn(
          "relative min-h-64 lg:min-h-[26rem]",
          align === "right" ? "lg:order-2" : "lg:order-1",
        )}
      >
        <Image
          src={image}
          alt=""
          fill
          sizes="(min-width: 1024px) 50vw, 100vw"
          className="object-cover"
        />
      </div>

      <div
        className={cn(
          "flex flex-col justify-center gap-5 p-8 sm:p-12 lg:p-14",
          align === "right" ? "lg:order-1" : "lg:order-2",
        )}
      >
        <h2 className="font-display text-2xl leading-tight text-ink sm:text-3xl">{title}</h2>
        <p className="max-w-prose text-sm leading-relaxed text-ink-700 sm:text-[0.9375rem]">
          {body}
        </p>
        <ButtonLink href={ctaHref} variant="outline" className="self-start">
          {ctaLabel}
        </ButtonLink>
      </div>
    </div>
  );
}
