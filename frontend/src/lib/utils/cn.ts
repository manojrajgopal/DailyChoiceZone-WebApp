import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names, with later Tailwind utilities winning over earlier ones.
 *
 * This is what lets a component expose a `className` prop that can genuinely
 * override its own defaults rather than fighting them in the cascade.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
