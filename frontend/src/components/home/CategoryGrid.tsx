import Link from "next/link";
import Image from "next/image";

import type { Category } from "@/types";

/**
 * "Shop by category".
 *
 * Editorial tiles rather than icon chips: a category is worth a photograph at
 * this point in the page, and the first tile runs wide so the grid does not
 * read as an undifferentiated wall of equal boxes.
 */
export function CategoryGrid({ categories }: { categories: Category[] }) {
  if (categories.length === 0) return null;

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 lg:gap-4">
      {categories.map((category, index) => (
        <li
          key={category.id}
          className={index === 0 ? "col-span-2 row-span-2 lg:col-span-2" : undefined}
        >
          <Link
            href={`/category/${category.slug}`}
            className="group relative block h-full overflow-hidden rounded-card"
          >
            <div
              className={
                index === 0
                  ? "relative aspect-square w-full lg:aspect-[4/5]"
                  : "relative aspect-[4/5] w-full"
              }
            >
              <Image
                src={category.image}
                alt=""
                fill
                sizes={
                  index === 0
                    ? "(min-width: 1024px) 34vw, 100vw"
                    : "(min-width: 1024px) 17vw, (min-width: 640px) 33vw, 50vw"
                }
                className="object-cover transition-transform duration-500 ease-brand group-hover:scale-105"
              />
            </div>

            <span className="absolute inset-0 bg-gradient-to-t from-ink/70 via-ink/10 to-transparent" />

            <span className="absolute inset-x-0 bottom-0 p-3 lg:p-4">
              <span className="block font-display text-base text-cream lg:text-lg">
                {category.name}
              </span>
              {index === 0 ? (
                <span className="mt-1 hidden text-xs leading-relaxed text-cream/75 lg:block">
                  {category.description}
                </span>
              ) : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
