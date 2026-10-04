import Link from "next/link";

import { adminLookupHref, type LookupEntity } from "@/lib/lookup/entities";
import { cn } from "@/lib/utils/cn";

/**
 * An ID in a table or a sentence, as a link to that record (docs/id-lookup.md).
 *
 * With `href`, straight to the record's screen; without, to the portal's ID
 * lookup page, which resolves the ID exactly and shows its preview.
 */
export function IdLink({
  entity,
  id,
  href,
  className,
}: {
  entity: LookupEntity;
  id: string;
  href?: string;
  className?: string;
}) {
  return (
    <Link
      href={href ?? adminLookupHref(entity, id)}
      className={cn("font-mono tracking-wide text-copper-600 hover:underline", className)}
      onClick={(event) => event.stopPropagation()}
    >
      {id}
    </Link>
  );
}
