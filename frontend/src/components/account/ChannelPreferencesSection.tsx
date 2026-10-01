"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { type ChannelChoice, type ChannelPreferences, getChannelPreferences, saveChannelPreferences } from "@/services/messagingService";
import { toast } from "@/store/toastStore";

const LABELS: Record<string, { label: string; hint: string }> = {
  "sms:transactional": { label: "Order updates by SMS", hint: "Shipping, delivery and payment updates to your phone." },
  "whatsapp:transactional": { label: "Order updates on WhatsApp", hint: "The same updates on WhatsApp — only if you turn it on." },
  "email:marketing": { label: "Offers and new arrivals by email", hint: "Sales, new collections and member offers. Unsubscribe from any of them." },
  "sms:marketing": { label: "Offers by SMS", hint: "Occasional texts about sales. Reply STOP to any of them to stop." },
  "whatsapp:marketing": { label: "Offers on WhatsApp", hint: "Occasional WhatsApp messages about sales." },
  "in_app:marketing": { label: "Offers in your notifications", hint: "Offers shown in the bell on the site." },
};

/**
 * SMS, WhatsApp and marketing choices. Marketing is off until the customer
 * turns it on; order updates are separate and never depend on it.
 */
export function ChannelPreferencesSection() {
  const [prefs, setPrefs] = useState<ChannelPreferences | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState("");

  useEffect(() => {
    let active = true;
    getChannelPreferences().then((value) => active && setPrefs(value)).catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, []);

  const toggle = async (choice: ChannelChoice, enabled: boolean) => {
    if (!prefs) return;
    const key = `${choice.channel}:${choice.category}`;
    const previous = prefs;
    setPrefs({ ...prefs, choices: prefs.choices.map((c) => (c === choice ? { ...c, enabled } : c)) });
    setSaving(key);
    try {
      setPrefs(await saveChannelPreferences([{ channel: choice.channel, category: choice.category, enabled }]));
      toast.success("Saved");
    } catch {
      setPrefs(previous);
      toast.error("We couldn't save that change. Please try again.");
    } finally {
      setSaving("");
    }
  };

  const shown = (prefs?.choices ?? []).filter((c) => c.available || c.enabled);
  const groups: [string, ChannelChoice[]][] = [
    ["Order updates", shown.filter((c) => c.category === "transactional")],
    ["Offers", shown.filter((c) => c.category === "marketing")],
  ];

  return (
    <section className="rounded-card border border-ink-200 bg-shell p-5">
      <h2 className="label-wide text-ink">Texts, WhatsApp and offers</h2>
      <p className="mt-2 text-xs leading-relaxed text-ink-500">
        We only send offers if you say yes. Order updates are separate, and you can change any of this at any time.
      </p>
      {failed ? (
        <div className="mt-4"><p className="text-sm text-ink-700">We couldn&rsquo;t load these just now.</p>
          <Button variant="outline" className="mt-3" onClick={() => { setFailed(false); getChannelPreferences().then(setPrefs).catch(() => setFailed(true)); }}>Try again</Button></div>
      ) : !prefs ? (
        <div className="mt-4 flex flex-col gap-3" role="status" aria-label="Loading">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-5 w-64 max-w-full" />)}</div>
      ) : (
        <div className="mt-4 flex flex-col gap-5">
          {!prefs.phoneUsable ? (
            <p className="text-xs text-ink-500">Add a mobile number in your <Link href="/account" className="underline underline-offset-2">profile</Link> to get texts and WhatsApp messages.</p>
          ) : null}
          {groups.map(([title, choices]) => choices.length ? (
            <div key={title}>
              <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-ink-500">{title}</h3>
              <ul className="mt-2 flex flex-col">
                {choices.map((choice) => {
                  const key = `${choice.channel}:${choice.category}`;
                  const meta = LABELS[key];
                  return (
                    <li key={key}>
                      <Checkbox label={<span>{meta?.label ?? key}<span className="block text-xs font-normal text-ink-400">{meta?.hint}</span></span>}
                        checked={choice.enabled} disabled={saving !== "" || (!choice.available && !choice.enabled)}
                        onChange={(e) => void toggle(choice, e.target.checked)} />
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null)}
        </div>
      )}
    </section>
  );
}
