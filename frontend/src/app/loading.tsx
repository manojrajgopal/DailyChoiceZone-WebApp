import { ProductGridSkeleton, Skeleton } from "@/components/ui/Skeleton";

/**
 * The default route-level loading state.
 *
 * Shaped like a listing page, since that is what most routes in this store
 * are. Individual routes can override it with their own `loading.tsx`.
 */
export default function Loading() {
  return (
    <div className="page-shell py-10">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="mt-5 h-9 w-64" />
      <Skeleton className="mt-4 h-4 w-full max-w-xl" />

      <div className="mt-10">
        <ProductGridSkeleton count={8} />
      </div>
    </div>
  );
}
