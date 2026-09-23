import Image from "next/image";

import taxConfigJson from "@/data/billing/tax-config.json";

import type { BillingAddress, BillingConfig, Invoice } from "@/types";

import { BillingStatusBadge } from "@/components/billing/BillingStatusBadge";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils/format";
import { paymentMethodLabel } from "@/services/billing/paymentService";

import logo from "@/../public/brand/logo.png";

/** The registration number printed on the document. */
const GSTIN = (taxConfigJson as { gstin: string }).gstin;

/**
 * The invoice document.
 *
 * One component renders it for the customer and for the administrator, because
 * an invoice the two parties see differently is not an invoice. It is also the
 * thing that gets printed, so it is laid out for paper first: fixed proportions,
 * no interactive affordances, and a `print:` pass that strips the page chrome
 * around it.
 *
 * The tax section shows CGST and SGST separately for a supply inside the
 * seller's state and a single IGST line otherwise — the distinction an Indian
 * invoice has to make, and the reason `placeOfSupply` is stored on the record
 * rather than re-derived when the document is opened. A sale is taxed by where
 * it went at the time; an address edited later must not silently restate it.
 *
 * Amounts print with decimals here and nowhere else. A document people file
 * needs to show exactly what was charged, including the paise a shelf price
 * rounds away.
 */

export function InvoiceDocument({
  invoice,
  config,
}: {
  invoice: Invoice;
  config: BillingConfig;
}) {
  const { breakdown, lines } = invoice;
  const tax = breakdown.tax;
  const intraState = tax.mode === "intra-state";
  const halfRate = tax.ratePercent / 2;

  return (
    <article className="invoice-document mx-auto w-full max-w-[52rem] bg-white text-ink print:max-w-none">
      {/* ------------------------------------------------------------ header */}
      <header className="flex flex-wrap items-start justify-between gap-6 border-b border-ink-200 p-8 print:p-0 print:pb-6">
        <div className="flex items-start gap-4">
          <Image
            src={logo}
            alt=""
            aria-hidden="true"
            className="h-14 w-14 shrink-0 rounded-pill object-contain"
            sizes="56px"
          />
          <div>
            <p className="font-display text-xl leading-tight text-ink">
              {config.business.storeName}
            </p>
            <p className="mt-0.5 text-[0.6875rem] text-ink-500">{config.business.legalName}</p>
            <address className="mt-2 text-xs not-italic leading-relaxed text-ink-500">
              {config.business.addressLine1}
              <br />
              {config.business.addressLine2}, {config.business.city}
              <br />
              {config.business.state} {config.business.postalCode}, {config.business.country}
              <br />
              {config.business.email} · {config.business.phone}
              <br />
              {config.business.website}
            </address>
          </div>
        </div>

        <div className="text-right">
          <h1 className="font-display text-2xl leading-none text-ink">Tax Invoice</h1>
          <dl className="mt-4 flex flex-col gap-1 text-xs">
            <DocMeta label="Invoice number" value={invoice.invoiceNumber} mono />
            <DocMeta label="Invoice date" value={formatDate(invoice.issuedAt)} />
            <DocMeta label="Order number" value={invoice.orderNumber} mono />
            <DocMeta label="Due date" value={formatDate(invoice.dueAt)} />
          </dl>
          <div className="mt-3 flex justify-end gap-1.5">
            <BillingStatusBadge domain="invoice" status={invoice.status} />
            <BillingStatusBadge domain="payment" status={invoice.paymentStatus} />
          </div>
        </div>
      </header>

      {/* --------------------------------------------------------- addresses */}
      <section className="grid gap-8 border-b border-ink-200 p-8 sm:grid-cols-3 print:p-0 print:py-6">
        <AddressBlock title="Bill to" address={invoice.billingAddress} />
        <AddressBlock title="Ship to" address={invoice.shippingAddress} />
        <div>
          <h2 className="label-wide text-ink-400">Tax details</h2>
          <dl className="mt-2.5 flex flex-col gap-1 text-xs text-ink-700">
            <DocMeta label="GSTIN" value={GSTIN} mono />
            <DocMeta label="Place of supply" value={invoice.placeOfSupply} />
            <DocMeta label="Tax treatment" value={intraState ? "Intra-state (CGST + SGST)" : "Inter-state (IGST)"} />
          </dl>
        </div>
      </section>

      {/* ------------------------------------------------------------- items */}
      <section className="p-8 print:p-0 print:py-6">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-xs">
            <thead>
              <tr className="border-b border-ink-300 text-left">
                <th scope="col" className="pb-2 pr-3 label-wide font-medium text-ink-400">
                  Item
                </th>
                <th scope="col" className="pb-2 px-2 label-wide font-medium text-ink-400">
                  HSN
                </th>
                <th scope="col" className="pb-2 px-2 text-right label-wide font-medium text-ink-400">
                  Qty
                </th>
                <th scope="col" className="pb-2 px-2 text-right label-wide font-medium text-ink-400">
                  Rate
                </th>
                <th scope="col" className="pb-2 px-2 text-right label-wide font-medium text-ink-400">
                  Disc.
                </th>
                <th scope="col" className="pb-2 px-2 text-right label-wide font-medium text-ink-400">
                  Taxable
                </th>
                <th scope="col" className="pb-2 px-2 text-right label-wide font-medium text-ink-400">
                  Tax
                </th>
                <th scope="col" className="pb-2 pl-2 text-right label-wide font-medium text-ink-400">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr
                  key={`${line.productId}-${line.size ?? ""}-${line.color ?? ""}-${index}`}
                  className="border-b border-ink-100 align-top"
                >
                  <td className="py-2.5 pr-3">
                    <span className="block font-medium text-ink">{line.name}</span>
                    <span className="mt-0.5 block text-[0.625rem] text-ink-400">
                      {line.sku}
                      {line.size ? ` · ${line.size}` : ""}
                      {line.color ? ` · ${line.color}` : ""}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 tabular-nums text-ink-500">{line.hsn}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-ink-700">
                    {line.quantity}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-ink-700">
                    {formatMoney(line.unitPrice, { showDecimals: true })}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-ink-700">
                    {line.discount > 0 ? `− ${formatMoney(line.discount, { showDecimals: true })}` : "—"}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-ink-700">
                    {formatMoney(line.taxableAmount, { showDecimals: true })}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-ink-700">
                    <span className="block">{formatMoney(line.tax, { showDecimals: true })}</span>
                    <span className="mt-0.5 block text-[0.625rem] text-ink-400">
                      {line.taxRatePercent}%
                    </span>
                  </td>
                  <td className="py-2.5 pl-2 text-right font-medium tabular-nums text-ink">
                    {formatMoney(line.lineTotal, { showDecimals: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ----------------------------------------------------- the totals */}
        <div className="mt-6 flex justify-end">
          <dl className="w-full max-w-xs flex-col gap-2 text-xs">
            <TotalRow label="Subtotal" value={formatMoney(breakdown.subtotal, { showDecimals: true })} />
            {breakdown.productDiscount > 0 ? (
              <TotalRow
                label="Product discount"
                value={`− ${formatMoney(breakdown.productDiscount, { showDecimals: true })}`}
              />
            ) : null}
            {breakdown.couponDiscount > 0 ? (
              <TotalRow
                label={`Coupon${breakdown.couponCode ? ` (${breakdown.couponCode})` : ""}`}
                value={`− ${formatMoney(breakdown.couponDiscount, { showDecimals: true })}`}
              />
            ) : null}
            <TotalRow
              label="Shipping"
              value={breakdown.shipping === 0 ? "Free" : formatMoney(breakdown.shipping, { showDecimals: true })}
            />
            {breakdown.otherCharges > 0 ? (
              <TotalRow label="Other charges" value={formatMoney(breakdown.otherCharges, { showDecimals: true })} />
            ) : null}

            <TotalRow label="Taxable value" value={formatMoney(tax.taxableAmount, { showDecimals: true })} divider />

            {tax.totalTax > 0 ? (
              intraState ? (
                <>
                  <TotalRow label={`CGST @ ${formatRate(halfRate)}%`} value={formatMoney(tax.cgst, { showDecimals: true })} />
                  <TotalRow label={`SGST @ ${formatRate(halfRate)}%`} value={formatMoney(tax.sgst, { showDecimals: true })} />
                </>
              ) : (
                <TotalRow label={`IGST @ ${formatRate(tax.ratePercent)}%`} value={formatMoney(tax.igst, { showDecimals: true })} />
              )
            ) : (
              <TotalRow label="Tax" value="—" />
            )}
            <TotalRow label="Total tax" value={formatMoney(tax.totalTax, { showDecimals: true })} />

            <div className="mt-2 flex items-baseline justify-between gap-4 border-t-2 border-ink pt-2.5">
              <dt className="text-sm font-medium text-ink">Grand total</dt>
              <dd className="font-display text-lg tabular-nums text-ink">
                {formatMoney(breakdown.grandTotal, { showDecimals: true })}
              </dd>
            </div>

            {invoice.amountRefunded > 0 ? (
              <TotalRow
                label="Refunded"
                value={`− ${formatMoney(invoice.amountRefunded, { showDecimals: true })}`}
              />
            ) : null}
          </dl>
        </div>
      </section>

      {/* ----------------------------------------------------------- payment */}
      <section className="grid gap-6 border-t border-ink-200 p-8 sm:grid-cols-2 print:p-0 print:py-6">
        <div>
          <h2 className="label-wide text-ink-400">Payment</h2>
          <dl className="mt-2.5 flex flex-col gap-1 text-xs text-ink-700">
            <DocMeta label="Method" value={paymentMethodLabel(invoice.paymentMethod)} />
            <DocMeta label="Status" value={paymentStatusLabel(invoice)} />
            <DocMeta label="Amount paid" value={formatMoney(invoice.amountPaid, { showDecimals: true })} />
          </dl>
          <p className="mt-3 max-w-prose text-[0.6875rem] leading-relaxed text-ink-500">
            {invoice.terms}
          </p>
        </div>

        <div>
          <h2 className="label-wide text-ink-400">Notes</h2>
          <p className="mt-2.5 max-w-prose text-[0.6875rem] leading-relaxed text-ink-500">
            {invoice.notes}
          </p>
        </div>
      </section>

      <footer className="border-t border-ink-200 px-8 py-5 text-center text-[0.6875rem] text-ink-400 print:px-0">
        {config.invoice.footer}
      </footer>
    </article>
  );
}

/* ------------------------------------------------------------------ pieces */

function AddressBlock({ title, address }: { title: string; address: BillingAddress }) {
  return (
    <div>
      <h2 className="label-wide text-ink-400">{title}</h2>
      <address className="mt-2.5 text-xs not-italic leading-relaxed text-ink-700">
        <span className="block font-medium text-ink">{address.fullName}</span>
        {address.line1}
        {address.line2 ? (
          <>
            <br />
            {address.line2}
          </>
        ) : null}
        <br />
        {address.city}, {address.state} {address.postalCode}
        <br />
        {address.country}
        {address.phone ? (
          <>
            <br />
            {address.phone}
          </>
        ) : null}
        {address.email ? (
          <>
            <br />
            {address.email}
          </>
        ) : null}
      </address>
    </div>
  );
}

function DocMeta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-400">{label}</dt>
      <dd className={mono ? "font-medium tabular-nums text-ink" : "text-ink-700"}>{value}</dd>
    </div>
  );
}

function TotalRow({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  return (
    <div
      className={
        divider
          ? "mt-1.5 flex justify-between gap-4 border-t border-ink-200 pt-2"
          : "flex justify-between gap-4"
      }
    >
      <dt className="text-ink-500">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}

/** `2.5` prints as `2.5`, `9` as `9` — no trailing `.0` on a document. */
function formatRate(rate: number): string {
  return Number.isInteger(rate) ? String(rate) : rate.toFixed(2).replace(/0$/, "");
}

function paymentStatusLabel(invoice: Invoice): string {
  if (invoice.paymentStatus === "paid") return "Paid in full";
  if (invoice.paymentStatus === "pending") return "Payable on delivery";
  if (invoice.paymentStatus === "partially-refunded") return "Partially refunded";
  if (invoice.paymentStatus === "refunded") return "Refunded";
  if (invoice.paymentStatus === "failed") return "Payment failed";
  return "Authorised";
}

