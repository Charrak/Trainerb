import type { Response } from 'express';
import type { InvoiceDownload } from './invoices';

/**
 * Send a rendered PDF.
 *
 * `attachment` is deliberate: browsers must not render the document in a viewer
 * the user can mistake for a web page, and the file name tells them what they
 * downloaded. `private` and `no-store` keep invoices out of shared caches — the
 * response contains a name, an address and an amount.
 */
export function pdfResponse(res: Response, file: InvoiceDownload): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(file.content);
}

/**
 * Send the bookkeeping export (CSV or bundle PDF).
 *
 * The same headers as a single document: a download, never something a browser
 * renders, and never cached — an export names every buyer of a period.
 */
export function fileResponse(res: Response, file: { fileName: string; content: Buffer },
                             contentType: string): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(file.content);
}
