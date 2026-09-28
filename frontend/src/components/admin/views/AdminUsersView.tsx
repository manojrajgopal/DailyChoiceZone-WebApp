"use client";

import { useState } from "react";
import { Pencil, Plus, Power, ShieldCheck, Trash2 } from "lucide-react";

import type { AdminRole, AdminUser } from "@/types/admin";

import {
  AdminButton,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, FormGrid } from "@/components/admin/ui/AdminForm";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { DomainStatus, StatusBadge } from "@/components/admin/ui/StatusBadge";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { useAdminSession } from "@/hooks/useAdminSession";
import { useSiteContent } from "@/hooks/useSiteContent";
import { formatDate } from "@/lib/utils/format";
import { permissionsFor } from "@/services/admin/adminAuthService";
import {
  deleteAdminUser,
  emptyAdminUser,
  listAdminUsers,
  saveAdminUser,
  setAdminUserStatus,
} from "@/services/admin/settingsAdminService";
import { toast } from "@/store/toastStore";

/**
 * Admin user management.
 *
 * Roles here are a **placeholder**, not an authorisation system. They shape the
 * UI — which nav items and buttons a role sees — and nothing more. Real
 * enforcement has to live in the API, because a check the browser performs is
 * a check the browser can skip.
 */
export function AdminUsersView() {
  const roles = useSiteContent()?.adminRoles ?? [];
  const users = useAdminResource(() => listAdminUsers(), []);
  const { user: currentUser } = useAdminSession();

  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [password, setPassword] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = users.data ?? [];

  const onSave = async () => {
    if (!editing) return;
    setBusy(true);
    const result = await saveAdminUser(editing, password || undefined);
    setBusy(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${result.data.name} saved`);
    close();
    await users.reload();
  };

  /** Close the dialog and forget the password rather than leave it in state. */
  const close = () => {
    setEditing(null);
    setPassword("");
  };

  const onToggle = async (user: AdminUser) => {
    setBusy(true);
    const result = await setAdminUserStatus(
      user.id,
      user.status === "active" ? "disabled" : "active",
    );
    setBusy(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${user.name} ${user.status === "active" ? "disabled" : "enabled"}`);
    await users.reload();
  };

  const onDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    const result = await deleteAdminUser(pendingDelete.id);
    setBusy(false);
    setPendingDelete(null);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${result.data} removed`);
    await users.reload();
  };

  const columns: Column<AdminUser>[] = [
    {
      id: "name",
      header: "Name",
      sortValue: (user) => user.name,
      cell: (user) => (
        <span className="flex items-center gap-2.5">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-admin-raised text-[0.625rem] font-semibold text-admin-muted">
            {user.avatarInitials}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-admin-ink">
              {user.name}
              {user.id === currentUser?.id ? (
                <span className="ml-1.5 text-[0.625rem] font-normal text-admin-faint">(you)</span>
              ) : null}
            </span>
            <span className="block max-w-[13rem] truncate text-[0.625rem] text-admin-faint">
              {user.email}
            </span>
          </span>
        </span>
      ),
    },
    {
      id: "role",
      header: "Role",
      sortValue: (user) => user.role,
      cell: (user) => {
        const role = roles.find((entry) => entry.value === user.role);
        return (
          <span className="min-w-0">
            <StatusBadge tone={user.role === "super-admin" ? "info" : "neutral"}>
              {role?.label ?? user.role}
            </StatusBadge>
            <span className="mt-1 block max-w-[16rem] truncate text-[0.625rem] text-admin-faint">
              {permissionsFor(user.role).length} permissions
            </span>
          </span>
        );
      },
    },
    {
      id: "lastLogin",
      header: "Last login",
      hideBelow: "md",
      sortValue: (user) => user.lastLoginAt ?? "",
      cell: (user) => (
        <span className="whitespace-nowrap text-xs text-admin-muted">
          {user.lastLoginAt ? formatDate(user.lastLoginAt) : "Never"}
        </span>
      ),
    },
    {
      id: "created",
      header: "Added",
      hideBelow: "lg",
      sortValue: (user) => user.createdAt,
      cell: (user) => (
        <span className="whitespace-nowrap text-xs text-admin-muted">
          {formatDate(user.createdAt)}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (user) => user.status,
      cell: (user) => <DomainStatus domain="generic" status={user.status} />,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (user) => (
        <span className="flex items-center justify-end gap-0.5">
          <button
            type="button"
            onClick={() => setEditing({ ...user })}
            aria-label={`Edit ${user.name}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>

          <button
            type="button"
            onClick={() => void onToggle(user)}
            disabled={busy || user.id === currentUser?.id}
            aria-label={user.status === "active" ? `Disable ${user.name}` : `Enable ${user.name}`}
            title={
              user.id === currentUser?.id
                ? "You cannot disable your own account"
                : user.status === "active"
                  ? "Disable"
                  : "Enable"
            }
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink disabled:opacity-30"
          >
            <Power className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>

          <button
            type="button"
            onClick={() => setPendingDelete(user)}
            disabled={user.id === currentUser?.id}
            aria-label={`Remove ${user.name}`}
            title={user.id === currentUser?.id ? "You cannot remove your own account" : "Remove"}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-[#fbeaea] hover:text-[#a32424] disabled:opacity-30"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Admin users"
        description="Who can sign in to this portal, and what each role can reach."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Admin users" }]}
        actions={
          <AdminButton variant="primary" onClick={() => setEditing(emptyAdminUser())}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
            Add admin
          </AdminButton>
        }
      />

      {/* --------------------------------------------- how roles are applied */}
      <div className="mb-4 flex items-start gap-3 rounded-[3px] border border-admin-border bg-admin-surface p-3.5">
        <ShieldCheck
          className="mt-0.5 h-4 w-4 shrink-0 text-admin-faint"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <p className="text-xs leading-relaxed text-admin-muted">
          <strong className="text-admin-ink">A role is enforced by the server.</strong> Every
          request from this portal carries the signed-in administrator&rsquo;s token, and the API
          checks the role&rsquo;s permissions before it writes anything. What the interface hides
          is a courtesy on top of that, not the check itself.
        </p>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(user) => user.id}
        isLoading={users.isLoading}
        pageSize={10}
        emptyTitle="No admin users"
        emptyDescription="Add someone to give them portal access."
      />

      {/* --------------------------------------------------- role reference */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {roles.map((role) => (
          <div
            key={role.value}
            className="rounded-[3px] border border-admin-border bg-admin-surface p-3"
          >
            <p className="text-xs font-semibold text-admin-ink">{role.label}</p>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-admin-muted">
              {role.description}
            </p>
            <p className="mt-2 text-[0.625rem] text-admin-faint tabular-nums">
              {permissionsFor(role.value as AdminRole).length} permissions
            </p>
          </div>
        ))}
      </div>

      <Modal
        open={editing !== null}
        onOpenChange={(open) => !open && close()}
        title={editing?.name ? `Edit ${editing.name}` : "Add admin user"}
        className="max-w-md"
      >
        {editing ? (
          <div className="flex flex-col gap-4">
            <FormGrid columns={1}>
              <AdminInput
                label="Full name"
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                required
              />
              <AdminInput
                label="Email address"
                type="email"
                value={editing.email}
                onChange={(event) => setEditing({ ...editing, email: event.target.value })}
                required
                hint="Used to sign in."
              />
              <AdminSelect
                label="Role"
                value={editing.role}
                onChange={(event) =>
                  setEditing({ ...editing, role: event.target.value as AdminUser["role"] })
                }
                options={roles.map((role) => ({ value: role.value, label: role.label }))}
                hint={roles.find((role) => role.value === editing.role)?.description}
              />
              <AdminSelect
                label="Status"
                value={editing.status}
                onChange={(event) =>
                  setEditing({ ...editing, status: event.target.value as AdminUser["status"] })
                }
                options={[
                  { value: "active", label: "Active — can sign in" },
                  { value: "disabled", label: "Disabled — cannot sign in" },
                ]}
              />
              <AdminInput
                label={editing.id ? "New password" : "Password"}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required={!editing.id}
                hint={
                  editing.id
                    ? "Leave blank to keep the current password."
                    : "At least eight characters. Hashed on the server; never stored as typed."
                }
              />
            </FormGrid>

            <div className="flex justify-end gap-2">
              <AdminButton variant="secondary" onClick={close}>
                Cancel
              </AdminButton>
              <AdminButton variant="primary" loading={busy} onClick={() => void onSave()}>
                Save admin
              </AdminButton>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Remove admin user?"
        loading={busy}
        confirmLabel="Remove access"
        message={
          <>
            <strong className="text-admin-ink">{pendingDelete?.name}</strong> will lose access to
            this portal. Disabling the account keeps the record if they might return.
          </>
        }
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
