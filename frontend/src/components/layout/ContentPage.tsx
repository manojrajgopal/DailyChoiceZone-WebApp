import { Breadcrumb } from "@/components/ui/Breadcrumb";

/**
 * The shell for every static content page.
 *
 * Typography is set here once — measure, leading and heading rhythm — so
 * About, FAQ, Shipping and the legal pages all read as one publication rather
 * than four differently styled documents.
 */
export function ContentPage({
  title,
  intro,
  updated,
  children,
}: {
  title: string;
  intro?: string;
  /** Shown as "Last updated" on policy pages. */
  updated?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="page-shell py-8 sm:py-12">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: title }]} />

      <header className="mt-5 max-w-3xl">
        <h1 className="font-display text-[1.875rem] leading-tight text-ink sm:text-4xl">
          {title}
        </h1>
        {intro ? (
          <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-700 sm:text-base">
            {intro}
          </p>
        ) : null}
        {updated ? (
          <p className="mt-4 label-wide text-ink-400">Last updated {updated}</p>
        ) : null}
      </header>

      <div
        className={[
          "mt-10 max-w-3xl",
          // Section rhythm
          "[&_section]:mt-10 [&_section:first-child]:mt-0",
          // Headings
          "[&_h2]:font-display [&_h2]:text-xl [&_h2]:text-ink [&_h2]:mb-3",
          "[&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-ink [&_h3]:mt-6 [&_h3]:mb-2",
          // Body copy
          "[&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-ink-700 [&_p]:mt-3",
          "[&_p:first-child]:mt-0",
          // Lists
          "[&_ul]:mt-3 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5",
          "[&_li]:list-disc [&_li]:text-sm [&_li]:leading-relaxed [&_li]:text-ink-700",
          "[&_li]:marker:text-copper-400",
          // Links
          "[&_a]:text-copper-700 [&_a]:underline [&_a]:underline-offset-2",
          "[&_a:hover]:text-ink",
          // Tables, used by the size guide
          "[&_table]:mt-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm",
          "[&_th]:border-b [&_th]:border-ink-200 [&_th]:py-2.5 [&_th]:text-left",
          "[&_th]:label-wide [&_th]:text-ink-500",
          "[&_td]:border-b [&_td]:border-ink-100 [&_td]:py-2.5 [&_td]:text-ink-700",
          "[&_td]:tabular-nums",
        ].join(" ")}
      >
        {children}
      </div>
    </div>
  );
}
