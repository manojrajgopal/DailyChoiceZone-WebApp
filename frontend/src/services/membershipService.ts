/**
 * The membership programme.
 *
 * Shoppers read the programme and its plans, buy one through the same hosted
 * payment sheet as an order, and see what their membership has saved them.
 * The store edits the programme, its plans and its members. Every call throws
 * `ApiError` on failure; its `message` is written for people and can be shown
 * as it is.
 */

import type { GatewayHandoff } from "@/types";

import { apiDelete, apiGet, apiPost, apiPut, query } from "@/services/api/client";

const CUSTOMER = { auth: "customer" } as const;
const ADMIN = { auth: "admin" } as const;

/* -------------------------------------------------------------------- types */

export interface MembershipProgramme {
  name: string;
  tagline: string;
  enabled: boolean;
}

export interface MembershipPlan {
  id: string;
  name: string;
  description: string;
  durationMonths: number;
  /** Rupees. */
  price: number;
  /** Rupees; shown struck through when set. */
  compareAtPrice: number | null;
  /** Rupees. */
  pricePerMonth: number;
  freeDelivery: boolean;
  /** Null means unlimited. */
  freeDeliveriesPerMonth: number | null;
  memberDiscountPercent: number;
  extraReturnDays: number;
  earlyAccess: boolean;
  prioritySupport: boolean;
  /** e.g. "Best value". Empty for none. */
  badge: string;
  active: boolean;
  sortOrder: number;
}

/** A plan as the store edits it: everything but the fields the server works out. */
export type MembershipPlanInput = Omit<MembershipPlan, "id" | "pricePerMonth">;

export type MembershipStatus = "active" | "expired" | "cancelled" | "pending";

export interface MembershipBenefits {
  freeDelivery: boolean;
  freeDeliveriesPerMonth: number | null;
  memberDiscountPercent: number;
  extraReturnDays: number;
  earlyAccess: boolean;
  prioritySupport: boolean;
}

export interface MembershipSummary {
  id: string;
  planId: string;
  planName: string;
  status: MembershipStatus;
  /** ISO 8601. */
  startsAt: string;
  /** ISO 8601. */
  endsAt: string;
  /** Paise. */
  amount: number;
  /** The benefits as they were when the plan was bought. */
  benefits: Partial<MembershipBenefits>;
  /** Null when deliveries are unlimited or not included. */
  freeDeliveriesLeftThisMonth: number | null;
  /** Rupees. */
  savedOnOrders: number;
  freeDeliveryOrders: number;
}

export interface MembershipOverview extends MembershipProgramme {
  plans: MembershipPlan[];
  membership: MembershipSummary | null;
}

export interface MyMembership {
  programme: MembershipProgramme;
  membership: MembershipSummary | null;
  history: MembershipSummary[];
}

export interface MembershipCheckout {
  membershipId: string;
  status: MembershipStatus;
  /**
   * What the payment sheet needs. Memberships have no payment window, so
   * `expiresAt` and `secondsLeft` are absent. Null when the membership is
   * already active and no payment is needed.
   */
  gateway: GatewayHandoff | null;
  membership: MembershipSummary | null;
}

export interface GatewayConfirmation {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  razorpaySignature: string;
}

export interface MemberRow extends MembershipSummary {
  customerId: string;
  customerName: string;
  customerEmail: string;
  paidAt: string | null;
  createdAt?: string;
}

export interface MemberPage {
  items: MemberRow[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  counts: { active: number; pending: number; expired: number; cancelled: number };
  plans: { id: string; name: string }[];
}

/* ----------------------------------------------------------------- shoppers */

/**
 * The programme and its plans.
 *
 * Public, but sent with the shopper's session when there is one, so a member
 * also gets their own membership back. Without a session no header is sent.
 */
export function getMembershipOverview(): Promise<MembershipOverview> {
  return apiGet("/memberships", CUSTOMER);
}

export function getMyMembership(): Promise<MyMembership> {
  return apiGet("/memberships/me", CUSTOMER);
}

export function startMembershipCheckout(planId: string): Promise<MembershipCheckout> {
  return apiPost("/memberships/checkout", { planId }, CUSTOMER);
}

export function verifyMembershipPayment(
  membershipId: string,
  confirmation: GatewayConfirmation,
): Promise<MembershipSummary> {
  return apiPost(`/memberships/${encodeURIComponent(membershipId)}/verify`, confirmation, CUSTOMER);
}

export function abandonMembershipCheckout(membershipId: string): Promise<void> {
  return apiPost(`/memberships/${encodeURIComponent(membershipId)}/abandon`, {}, CUSTOMER);
}

/* -------------------------------------------------------------------- store */

export function getMembershipProgramme(): Promise<MembershipProgramme> {
  return apiGet("/admin/memberships/programme", ADMIN);
}

export function saveMembershipProgramme(programme: MembershipProgramme): Promise<MembershipProgramme> {
  return apiPut("/admin/memberships/programme", programme, ADMIN);
}

export function listMembershipPlans(): Promise<MembershipPlan[]> {
  return apiGet("/admin/memberships/plans", ADMIN);
}

export function createMembershipPlan(plan: MembershipPlanInput): Promise<MembershipPlan> {
  return apiPost("/admin/memberships/plans", plan, ADMIN);
}

export function updateMembershipPlan(
  id: string,
  patch: Partial<MembershipPlanInput>,
): Promise<MembershipPlan> {
  return apiPut(`/admin/memberships/plans/${encodeURIComponent(id)}`, patch, ADMIN);
}

/** "retired" when somebody has bought the plan: it stops being sold, and existing members keep it. */
export function deleteMembershipPlan(id: string): Promise<{ outcome: "deleted" | "retired" }> {
  return apiDelete(`/admin/memberships/plans/${encodeURIComponent(id)}`, ADMIN);
}

export function listMembers(filters: { status?: string; limit?: number } = {}): Promise<MemberRow[]> {
  return apiGet(`/admin/memberships${query({ status: filters.status, limit: filters.limit })}`, ADMIN);
}

/**
 * Every member, filtered and paged by the server. `plan` is a Membership plan
 * ID, `q` a Membership ID (or Customer ID) and `customer` a Customer ID — each
 * matched exactly; names, emails and plan names match nothing.
 */
export function searchMembers(filters: {
  status?: string;
  plan?: string;
  q?: string;
  customer?: string;
  page?: number;
  pageSize?: number;
}): Promise<MemberPage> {
  return apiGet(`/admin/memberships/search${query(filters)}`, ADMIN);
}

/** End an active membership now. */
export function cancelMembership(id: string): Promise<MembershipSummary> {
  return apiPost(`/admin/memberships/${encodeURIComponent(id)}/cancel`, {}, ADMIN);
}
