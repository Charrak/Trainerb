import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import type { Request } from 'express';
import { Sessions, type SessionContext } from './sessions';
import { apiError, keyedHash, requireUuid } from './security';
import { getConfig } from './config';
import { invoiceFileName, renderInvoicePdf } from './invoice-pdf';

type Settings = NonNullable<Awaited<ReturnType<Database['commerceSettings']['findUnique']>>>;

export type InvoiceDownload = { fileName: string; content: Buffer };
export type InvoiceLink = { id: string; invoice_number: string; href: string };
export type InvoiceSummary = { id: string; invoice_number: string; issued_at: Date; order_id: string;
  order_number: string; total_gross_cents: string; currency: string; payment_state: string };

/** The guest cart cookie is the only proof a guest has; it is an HMAC, not an id. */
const GUEST_CART_COOKIE = '__Host-guest-cart';

const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');

/**
 * Invoices: issuing and downloading.
 *
 * Both the account checkout and the guest checkout issue their invoice here, so
 * the number circle, the snapshot shape and the document can never diverge
 * between the two paths. Issuing happens inside the caller's transaction — the
 * invoice and the order are one unit.
 */
@Injectable()
export class Invoices {
  constructor(private readonly db: Database, private readonly sessions: Sessions) {}

  /**
   * A link to the document, but only once the money is really there.
   *
   * An unpaid transfer order would otherwise offer a download that looks like a
   * receipt for a payment that has not happened.
   */
  linkFor(order: { id: string; payment_state: string; invoice?: { id: string; invoice_number: string } | null },
): InvoiceLink | null {
    if (order.payment_state !== 'paid' || !order.invoice) return null;
    return { id: order.invoice.id, invoice_number: order.invoice.invoice_number,
      href: `/invoices/${order.invoice.id}/pdf` };
  }

  /**
   * Guests have no session, so the cart cookie stands in for the account: the
   * invoice is served only when its order is the order of that very cart.
   *
   * Linking the paid order to a new account does **not** close this path: the
   * buyer only receives their activation mail with the payment, so at that
   * moment the cookie is the sole proof of the purchase. It is bound to the cart
   * that produced the order, which is exactly as strong as the session that a
   * later account login would provide.
   */
  async downloadForGuest(req: Request, invoiceIdInput: string): Promise<InvoiceDownload> {
    const invoiceId = requireUuid(invoiceIdInput);
    const secret = req.cookies?.[GUEST_CART_COOKIE];
    if (typeof secret !== 'string' || !secret) throw missing();
    const hash = keyedHash(getConfig().tokenKey, 'guest-cart', secret);
    // The order closes the cart (`converted`); that closed cart is exactly the
    // proof the guest still holds for the receipt.
    const cart = await this.db.cart.findFirst({ where: { guest_secret_hash: hash, status: 'converted' },
      select: { id: true } });
    if (!cart) throw missing();
    const invoice = await this.db.invoice.findUnique({ where: { id: invoiceId },
      include: { order: { select: { cart_id: true, payment_state: true, user_id: true } } } });
    if (!invoice || invoice.order.cart_id !== cart.id || invoice.order.payment_state !== 'paid') throw missing();
    return { fileName: invoiceFileName(invoice.invoice_number), content: this.render(invoice) };
  }

  /** The account's own invoice list, newest first. */
  async listMine(ctx: SessionContext): Promise<{ data: InvoiceSummary[] }> {
    const rows = await this.db.invoice.findMany({ where: { order: { user_id: ctx.user.id } },
      include: { order: { select: { order_number: true, payment_state: true } } },
      orderBy: [{ issued_at: 'desc' }, { id: 'desc' }], take: 100 });
    return { data: rows.map(invoice => ({ id: invoice.id, invoice_number: invoice.invoice_number,
      issued_at: invoice.issued_at, order_id: invoice.order_id, order_number: invoice.order.order_number,
      total_gross_cents: String(invoice.total_gross_cents), currency: invoice.currency,
      payment_state: invoice.order.payment_state })) };
  }

  /** Staff download for support cases (`orders.read`). */
  async downloadForStaff(invoiceIdInput: string): Promise<InvoiceDownload> {
    const invoiceId = requireUuid(invoiceIdInput);
    const invoice = await this.db.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw missing();
    return { fileName: invoiceFileName(invoice.invoice_number), content: this.render(invoice) };
  }

  private render(invoice: {
    invoice_number: string; issued_at: Date; seller_snapshot: unknown; buyer_snapshot: unknown;
    lines_snapshot: unknown; total_gross_cents: bigint; currency: string; due_at: Date | null;
    payment_reference: string | null; recipient_email: string | null;
  }): Buffer {
    return renderInvoicePdf({ invoice_number: invoice.invoice_number, issued_at: invoice.issued_at,
      seller_snapshot: invoice.seller_snapshot, buyer_snapshot: invoice.buyer_snapshot,
      lines_snapshot: invoice.lines_snapshot, total_gross_cents: invoice.total_gross_cents,
      currency: invoice.currency, due_at: invoice.due_at, payment_reference: invoice.payment_reference,
      recipient_email: invoice.recipient_email });
  }

  /**
   * Freeze the invoice for an order. Called only where money becomes real (an
   * invoice/transfer order) — never for a card payment, which gets its receipt
   * from the provider instead.
   */
  async issue(tx: Prisma.TransactionClient, orderId: string, settings: Settings,
              recipientEmail?: string | null): Promise<void> {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: {
      items: { orderBy: { position: 'asc' }, include: { price: { select: { tax_category: true } } } } } });
    const numberRow = await tx.$queryRaw<{ number: string }[]>`SELECT trainerb_next_order_number('TB-RE-', 'invoice_number_seq') AS number`;
    await tx.invoice.create({ data: { id: uuidv7(), order_id: orderId, invoice_number: numberRow[0].number,
      seller_snapshot: { name: settings.invoice_seller_name, street: settings.invoice_seller_street,
        postal_code: settings.invoice_seller_postal, city: settings.invoice_seller_city,
        country: settings.invoice_seller_country, email: settings.invoice_seller_email,
        vat_id: settings.invoice_seller_vat_id,
        // The bank details belong on the document; freezing them here keeps the
        // payment instruction valid even after an account change later.
        bank: { holder: settings.bank_account_holder, iban: settings.bank_iban, bic: settings.bank_bic,
          name: settings.bank_name } } as Prisma.InputJsonValue,
      buyer_snapshot: order.billing_snapshot as Prisma.InputJsonValue,
      lines_snapshot: order.items.map(item => ({ position: item.position, title: item.title_snapshot,
        variant: item.variant_snapshot, quantity: item.quantity, unit_gross_cents: String(item.unit_gross_cents),
        discount_cents: String(item.discount_cents), total_gross_cents: String(item.total_gross_cents),
        // An identifier, not a rate: the document must not invent a tax split.
        tax_category: item.price.tax_category })) as Prisma.InputJsonValue,
      total_gross_cents: order.total_gross_cents, currency: order.currency, due_at: order.due_at,
      payment_reference: order.payment_reference, recipient_email: recipientEmail ?? null } });
  }

  /**
   * The PDF for one invoice, for its owner or for staff with order access.
   *
   * Rendering reads the invoice snapshot only, so the download is the issued
   * document — not a fresh calculation that could drift from what was sent.
   */
  async download(ctx: SessionContext, invoiceIdInput: string): Promise<InvoiceDownload> {
    const invoiceId = requireUuid(invoiceIdInput);
    const invoice = await this.db.invoice.findUnique({ where: { id: invoiceId }, include: {
      order: { select: { user_id: true, buyer_email_canonical: true } } } });
    if (!invoice) throw missing();
    const staff = ctx.session.kind === 'backoffice' && ctx.permissionKeys.has('orders.read');
    const owner = invoice.order.user_id !== null && invoice.order.user_id === ctx.user.id;
    // An unlinked guest invoice stays reachable through the guest order cookie
    // (see GuestCheckout.invoiceForGuest); a session alone proves nothing there.
    if (!staff && !owner) throw missing();
    return { fileName: invoiceFileName(invoice.invoice_number), content: this.render(invoice) };
  }
}
