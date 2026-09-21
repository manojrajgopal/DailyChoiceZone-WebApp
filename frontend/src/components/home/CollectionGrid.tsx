import Link from "next/link";
import Image from "next/image";
import { ArrowRight } from "lucide-react";

import type { Collection } from "@/types";

/** Featured collection cards, each linking to its own collection page. */
export function CollectionGrid({ collections }: { collections: Collection[] }) {
  if (collections.length === 0) return null;

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
      {collections.map((collection) => (
        <li key={collection.id}>
          <Link
            href={`/collection/${collection.slug}`}
            className="group flex h-full flex-col overflow-hidden rounded-card bg-shell"
          >
            <div className="relative aspect-[16/10] w-full overflow-hidden">
              <Image
                src={collection.image}
                alt=""
                fill
                sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                className="object-cover transition-transform duration-500 ease-brand group-hover:scale-105"
              />
            </div>

            <div className="flex flex-1 flex-col p-5">
              <h3 className="font-display text-lg text-ink">{collection.name}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-500">
                {collection.description}
              </p>

              <span className="mt-4 inline-flex items-center gap-1.5 label-wide text-copper-700">
                {collection.productIds.length} pieces
                <ArrowRight
                  className="h-3.5 w-3.5 transition-transform duration-200 ease-brand group-hover:translate-x-0.5"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
