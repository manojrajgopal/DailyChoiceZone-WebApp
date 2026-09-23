"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  AdminButton,
  AdminCard,
  AdminPageHeader,
} from "@/components/admin/ui/AdminChrome";
import { AdminInput, FormGrid, FormSection } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { useAdminSession } from "@/hooks/useAdminSession";
import { formatDate } from "@/lib/utils/format";
import { permissionsFor } from "@/services/admin/adminAuthService";
import { ROLES } from "@/services/admin/settingsAdminService";

/**
 * The signed-in admin's own profile.
 *
 * Name is editable; email and role are not — changing your own role would be a
 * privilege escalation, and it is exactly the operation a real backend must
 * refuse rather than the UI merely discourage.
 */
export function AdminProfileView() {
  const { user, isLoading, updateProfile } = useAdminSession();

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName((current) => current || user?.name || "");
  }, [user?.name]);

  if (isLoading || !user) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading profile" />
      </div>
    );
  }

  const role = ROLES.find((entry) => entry.value === user.role);
  const permissions = permissionsFor(user.role);

  const onSave = () => {
    if (name.trim().length < 2) return;
    setSaving(true);
    updateProfile({ name: name.trim() });
    setSaving(false);
  };

  return (
    <div>
      <AdminPageHeader
        title="My profile"
        description="Your details and what your role can reach."
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Store settings", href: "/admin/settings" },
          { label: "My profile" },
        ]}
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <FormSection title="Your details">
          <div className="mb-5 flex items-center gap-3">
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-pill bg-copper-600 text-sm font-semibold text-white">
              {user.avatarInitials}
            </span>
            <div>
              <p className="text-sm font-medium text-admin-ink">{user.name}</p>
              <p className="text-xs text-admin-muted">{role?.label ?? user.role}</p>
            </div>
          </div>

          <FormGrid>
            <AdminInput
              label="Full name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              className="sm:col-span-2"
            />

            <AdminInput
              label="Email address"
              value={user.email}
              disabled
              hint="Cannot be changed here."
              className="sm:col-span-2"
            />

            <AdminInput
              label="Role"
              value={role?.label ?? user.role}
              disabled
              hint="Only a super admin can change roles, and never their own."
            />

            <AdminInput
              label="Member since"
              value={formatDate(user.createdAt)}
              disabled
            />
          </FormGrid>

          <AdminButton
            variant="primary"
            className="mt-5"
            loading={saving}
            disabled={name.trim() === user.name || name.trim().length < 2}
            onClick={onSave}
          >
            Save changes
          </AdminButton>
        </FormSection>

        <div className="flex flex-col gap-4">
          <AdminCard title="Session">
            <dl className="flex flex-col gap-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-admin-muted">Status</dt>
                <dd>
                  <StatusBadge tone="good">Signed in</StatusBadge>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-admin-muted">Last login</dt>
                <dd className="text-admin-ink">
                  {user.lastLoginAt ? formatDate(user.lastLoginAt) : "—"}
                </dd>
              </div>
            </dl>

            <p className="mt-3 rounded-[3px] bg-admin-raised px-2.5 py-2 text-[0.625rem] leading-relaxed text-admin-muted">
              This session lives in your browser&rsquo;s local storage. A real deployment would use
              an httpOnly cookie the page cannot read.
            </p>
          </AdminCard>

          <AdminCard title={`Permissions (${permissions.length})`}>
            <ul className="flex flex-col gap-1.5">
              {permissions.map((permission) => (
                <li key={permission} className="flex items-start gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-1.5 h-1 w-1 shrink-0 rounded-pill bg-copper-500"
                  />
                  <code className="text-[0.625rem] text-admin-muted">{permission}</code>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[0.625rem] leading-relaxed text-admin-muted">
              These names shape the interface only. They are not enforced until the backend checks
              them.
            </p>
          </AdminCard>
        </div>
      </div>
    </div>
  );
}
