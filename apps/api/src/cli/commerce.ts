import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';

/**
 * Initial commerce configuration for a fresh installation.
 *
 * Sales stay **disabled** and every legal text starts as a draft: the operator
 * must enter real seller/bank data and activate the legally reviewed wording
 * themselves. Nothing here invents a company, an IBAN or a legal text.
 */
const drafts: Record<'terms' | 'withdrawal' | 'privacy', string> = {
  terms: 'ENTWURF – bitte durch die rechtlich geprüfte Fassung ersetzen.\n\n'
    + 'Diese Allgemeinen Geschäftsbedingungen gelten für Verträge über digitale Lerninhalte der Akademie. '
    + 'Der Vertrag kommt mit der Bestätigung der Bestellung zustande. Der Zugang zu den Inhalten wird nach '
    + 'vollständigem Zahlungseingang freigeschaltet. Änderungen des Leistungsumfangs werden vor der Bestellung angezeigt.',
  withdrawal: 'ENTWURF – bitte durch die rechtlich geprüfte Fassung ersetzen.\n\n'
    + 'Verbraucherinnen und Verbraucher haben ein vierzehntägiges Widerrufsrecht. Beim Kauf digitaler Inhalte '
    + 'kann dieses Recht erlöschen, wenn mit der Ausführung begonnen wurde, nachdem ausdrücklich zugestimmt und '
    + 'die Kenntnis vom Erlöschen bestätigt wurde. Ein pauschales Erlöschen wird nicht angenommen.',
  privacy: 'ENTWURF – bitte durch die rechtlich geprüfte Fassung ersetzen.\n\n'
    + 'Verarbeitet werden Bestands- und Vertragsdaten (Name, Anschrift, E-Mail, Bestellung, Zahlungseingang) '
    + 'zur Vertragserfüllung sowie zur Erfüllung gesetzlicher Aufbewahrungspflichten. Es werden keine '
    + 'Zahlungskartendaten gespeichert. Betroffenenrechte und Kontaktwege sind vor Veröffentlichung zu ergänzen.',
};

export async function seedCommerce(db: PrismaClient): Promise<void> {
  await db.$transaction(async tx => {
    for (const kind of ['terms', 'withdrawal', 'privacy'] as const) {
      let document = await tx.legalDocument.findFirst({ where: { kind } });
      if (!document) document = await tx.legalDocument.create({ data: { id: uuidv7(), kind } });
      const existing = await tx.legalDocumentVersion.findFirst({ where: { document_id: document.id } });
      if (!existing) {
        await tx.legalDocumentVersion.create({ data: { id: uuidv7(), document_id: document.id, version: 1,
          wording: drafts[kind], status: 'draft' } });
      }
    }
    // Turnover tax as data. 19 % is the German standard rate for online
    // training; 7 % exists for cases where a reduced rate applies. Both are
    // rows with an open-ended validity, so a change is a new row and never an
    // edit of history. The seed only creates what is missing.
    const rates: Array<{ category: string; rate_bp: number; label: string; note: string; is_default: boolean }> = [
      { category: 'standard', rate_bp: 1900, label: '19 %', is_default: true,
        note: 'Regelsteuersatz für Online-Training und digitale Kurse in Deutschland.' },
      { category: 'reduced', rate_bp: 700, label: '7 %', is_default: false,
        note: 'Ermäßigter Steuersatz; nur anwenden, wenn die Leistung darunter fällt.' },
    ];
    for (const rate of rates) {
      const existing = await tx.taxRate.findFirst({ where: { category: rate.category } });
      if (!existing) {
        await tx.taxRate.create({ data: { id: uuidv7(), category: rate.category, rate_bp: rate.rate_bp,
          label: rate.label, note: rate.note, is_default: rate.is_default,
          valid_from: new Date('2020-01-01T00:00:00Z') } });
      }
    }
    const settings = await tx.commerceSettings.findUnique({ where: { id: 1 } });
    if (!settings) {
      // Placeholder seller data; `sales_enabled` stays false until an operator
      // replaces it and activates the legal versions.
      await tx.commerceSettings.create({ data: { id: 1, sales_enabled: false,
        invoice_seller_name: 'Trainer B Akademie (Platzhalter – bitte ergänzen)',
        invoice_seller_street: 'Straße und Hausnummer ergänzen', invoice_seller_postal: '00000',
        invoice_seller_city: 'Ort ergänzen', invoice_seller_country: 'DE',
        invoice_seller_email: 'rechnung@example.invalid',
        // Ohne Steuernummer/USt-IdNr. ist eine Rechnung nicht vollständig; der
        // Platzhalter zwingt dazu, ihn vor dem ersten Verkauf zu ersetzen.
        invoice_seller_tax_number: '000/000/00000', small_business: false,
        bank_account_holder: 'Kontoinhaber ergänzen',
        bank_iban: 'DE00000000000000000000', payment_term_days: 14 } });
    }
  }, { timeout: 30_000 });
}
