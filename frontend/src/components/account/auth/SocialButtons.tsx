import type { SignInProvider } from "@/types/identity";

import { cn } from "@/lib/utils/cn";
import { oauthStartUrl } from "@/services/identityService";

/**
 * "Continue with Google / Apple / Microsoft".
 *
 * Plain links, because this is a full-page trip: the API sends the browser
 * to the provider and the provider sends it back to `/auth/complete`. `next`
 * is where to land afterwards — already checked to be a path on this site.
 */
export function SocialButtons({ providers, next, className }: { providers: SignInProvider[]; next: string; className?: string }) {
  if (providers.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-2.5", className)}>
      {providers.map((provider) => (
        <li key={provider.code}>
          <a
            href={oauthStartUrl(provider.code, next, "login")}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-control border border-ink-200 bg-shell px-6 text-sm font-medium text-ink transition-colors hover:border-ink"
          >
            Continue with {provider.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
