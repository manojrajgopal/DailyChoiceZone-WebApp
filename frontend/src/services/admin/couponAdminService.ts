import type { AdminCoupon, AdminResult, CouponStatus } from "@/types/admin";

import { adminDataSource } from "./admin-data-source.instance";

/** Coupon management. */

export function listCoupons(): Promise<AdminCoupon[]> {
  return adminDataSource.listCoupons();
}

/**
 * The status a coupon *should* have, given its dates.
 *
 * `disabled` is a deliberate admin decision and always wins; everything else is
 * derived, so a coupon cannot sit there claiming to be active a month after it
 * expired or before it has started.
 */
export function effectiveStatus(coupon: AdminCoupon, now = new Date()): CouponStatus {
  if (coupon.status === "disabled") return "disabled";
  if (new Date(coupon.startsAt) > now) return "scheduled";
  if (coupon.endsAt && new Date(coupon.endsAt) < now) return "expired";
  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) return "expired";
  return "active";
}

export async function saveCoupon(coupon: AdminCoupon): Promise<AdminResult<AdminCoupon>> {
  const code = coupon.code.trim().toUpperCase();

  if (!/^[A-Z0-9]{4,20}$/.test(code)) {
    return { ok: false, reason: "Use 4 to 20 letters and numbers, with no spaces." };
  }
  if (coupon.type === "percent" && (coupon.value <= 0 || coupon.value > 90)) {
    return { ok: false, reason: "A percentage discount must be between 1 and 90." };
  }
  if (coupon.type === "flat" && coupon.value <= 0) {
    return { ok: false, reason: "Enter a discount amount above zero." };
  }
  if (coupon.endsAt && new Date(coupon.endsAt) <= new Date(coupon.startsAt)) {
    return { ok: false, reason: "The end date must be after the start date." };
  }

  const existing = await adminDataSource.listCoupons();
  const clash = existing.find((entry) => entry.code.toUpperCase() === code && entry.id !== coupon.id);
  if (clash) return { ok: false, reason: `The code ${code} is already in use.` };

  return { ok: true, data: await adminDataSource.saveCoupon({ ...coupon, code }) };
}

export async function setCouponStatus(
  id: string,
  status: CouponStatus,
): Promise<AdminResult<AdminCoupon>> {
  const coupons = await adminDataSource.listCoupons();
  const coupon = coupons.find((entry) => entry.id === id);
  if (!coupon) return { ok: false, reason: "That coupon no longer exists." };
  return { ok: true, data: await adminDataSource.saveCoupon({ ...coupon, status }) };
}

export async function deleteCoupon(id: string): Promise<AdminResult<string>> {
  const coupons = await adminDataSource.listCoupons();
  const coupon = coupons.find((entry) => entry.id === id);
  if (!coupon) return { ok: false, reason: "That coupon no longer exists." };
  await adminDataSource.deleteCoupon(id);
  return { ok: true, data: coupon.code };
}

export function emptyCoupon(): AdminCoupon {
  const now = new Date();
  return {
    id: `coupon_${Date.now()}`,
    code: "",
    description: "",
    type: "percent",
    value: 10,
    minSubtotal: 999,
    maxDiscount: 500,
    startsAt: now.toISOString(),
    endsAt: null,
    usageLimit: null,
    usageCount: 0,
    status: "active",
    createdAt: now.toISOString(),
  };
}
