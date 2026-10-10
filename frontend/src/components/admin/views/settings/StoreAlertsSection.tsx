"use client";

import { useState } from "react";
import { BellRing } from "lucide-react";

import type { AlertChannel, AlertChannelStatus, StoreNotificationSettings } from "@/types/admin";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminToggle, FormGrid, FormSection, TagListInput } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { getAlertChannels, sendTestAlert } from "@/services/admin/settingsAdminService";
import { ApiError } from "@/services/api/client";
import { toast } from "@/store/toastStore";

const CHANNELS: { key: AlertChannel; label: string; description: string }[] = [
  { key: "inApp", label: "In the portal", description: "The bell at the top of every admin page." },
  { key: "email", label: "Email", description: "Administrators whose role covers the alert, and the recipients below." },
  { key: "sms", label: "SMS", description: "To the recipients' phone numbers below." },
  { key: "whatsapp", label: "WhatsApp", description: "To the recipients' phone numbers below, with an approved template." },
];

const GROUPS: { key: keyof StoreNotificationSettings; label: string; description: string }[] = [
  { key: "orderAlerts", label: "Orders", description: "A new order is placed, or an order is cancelled." },
  { key: "paymentAlerts", label: "Payments", description: "A customer's payment fails, or a payment webhook can't be processed." },
  { key: "lowStockAlerts", label: "Low stock", description: "A product falls to its low-stock threshold, or runs out." },
  { key: "waitlistAlerts", label: "Notify me requests", description: "A customer asks to be told when an out-of-stock product is back." },
  { key: "waitlistDigest", label: "Daily waitlist summary", description: "One email each morning: who is waiting, for what, and what came back." },
  { key: "reviewAlerts", label: "Reviews", description: "A review is waiting to be approved." },
  { key: "customerAlerts", label: "New customers", description: "Someone creates an account." },
];

/**
 * How the store team hears about things (docs/notifications.md): which alerts,
 * on which channels, and who besides the administrators gets them. Alerts
 * about something broken — a failed refund, a stuck shipment, a failed
 * backup — always go out and have no switch here.
 */
export function StoreAlertsSection({
  value,
  onChange,
}: {
  value: StoreNotificationSettings;
  onChange: (next: Partial<StoreNotificationSettings>) => void;
}) {
  const channels = useAdminResource(() => getAlertChannels(), []);
  const [testing, setTesting] = useState(false);

  const test = async () => {
    setTesting(true);
    try {
      await sendTestAlert();
      toast.success("Test alert sent. Check the bell, your inbox and your phone.");
      await channels.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "The test alert couldn't be sent.");
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <FormSection
        title="Store team alerts"
        description="What the team is told about as it happens. Alerts about something broken — a failed refund, a stuck shipment, a failed backup — always go out."
      >
        <div className="flex flex-col divide-y divide-admin-border">
          {GROUPS.map((group) => (
            <AdminToggle
              key={group.key}
              label={group.label}
              description={group.description}
              checked={Boolean(value[group.key])}
              onChange={(checked) => onChange({ [group.key]: checked } as Partial<StoreNotificationSettings>)}
            />
          ))}
        </div>
      </FormSection>

      <FormSection
        title="Alert recipients"
        description="These get every store alert, as well as the administrators whose role covers it. Use addresses and numbers that someone reads."
      >
        <FormGrid>
          <TagListInput
            label="Emails"
            hint="Up to 10. Press Enter after each."
            placeholder="owner@example.com"
            values={value.alertRecipients.emails}
            onChange={(emails) => onChange({ alertRecipients: { ...value.alertRecipients, emails } })}
          />
          <TagListInput
            label="Phone numbers (SMS and WhatsApp)"
            hint="Up to 5, with the country code: +91 98765 43210."
            placeholder="+91 98765 43210"
            values={value.alertRecipients.phones}
            onChange={(phones) => onChange({ alertRecipients: { ...value.alertRecipients, phones } })}
          />
        </FormGrid>
      </FormSection>

      <FormSection title="Channels" description="Where alerts go. A channel needs its provider set up before anything is sent on it.">
        <div className="flex flex-col divide-y divide-admin-border">
          {CHANNELS.map((channel) => (
            <ChannelRow
              key={channel.key}
              label={channel.label}
              description={channel.description}
              checked={value.alertChannels[channel.key]}
              status={channels.data?.[channel.key]}
              onChange={(checked) => onChange({ alertChannels: { ...value.alertChannels, [channel.key]: checked } })}
            />
          ))}
        </div>
        <FormGrid>
          <AdminInput
            label="WhatsApp template name"
            hint="An alert template approved in your WhatsApp Business account, with two body variables: the title, then the details and link."
            placeholder="store_alert"
            value={value.whatsappAlertTemplate.name}
            onChange={(event) => onChange({ whatsappAlertTemplate: { ...value.whatsappAlertTemplate, name: event.target.value.trim() } })}
          />
          <AdminInput
            label="Template language"
            placeholder="en"
            value={value.whatsappAlertTemplate.language}
            onChange={(event) => onChange({ whatsappAlertTemplate: { ...value.whatsappAlertTemplate, language: event.target.value.trim() } })}
          />
        </FormGrid>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <AdminButton onClick={() => void test()} loading={testing}>
            <BellRing className="h-3.5 w-3.5" aria-hidden="true" /> Send test alert
          </AdminButton>
          <p className="text-[0.6875rem] text-admin-muted">Uses the saved settings: save your changes first.</p>
        </div>
      </FormSection>
    </>
  );
}

function ChannelRow({
  label,
  description,
  checked,
  status,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  status?: AlertChannelStatus;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <AdminToggle label={label} description={description} checked={checked} onChange={onChange} />
      {status ? (
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <StatusBadge tone={status.configured ? "good" : "warning"}>
            {status.configured ? "Ready" : "Not set up"}
          </StatusBadge>
          {!status.configured && status.reason ? (
            <span className="text-[0.6875rem] text-admin-muted">{status.reason}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
