import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';

const rights: Record<string, string[]> = {
  participant: ['self.read','self.edit','learning.use','orders.read_own','certificates.read_own','newsletter.manage_own'],
  support: ['refunds.propose', 'users.read_limited','users.edit_limited','users.block','orders.read_limited','refunds.propose','access.manage','reports.read_basic','withdrawals.manage'],
  instructor: ['courses.read','courses.edit','media.upload','reports.read_assigned'],
  course_manager: ['courses.read','courses.edit','media.upload','reports.read_assigned','newsletter.draft'],
  admin: ['users.read','users.edit','users.block','courses.read','courses.create','courses.edit','courses.publish','products.manage','prices.manage','coupons.manage','media.upload','orders.read','orders.manage','refunds.manage','access.manage','certificates.manage','cms.edit','legal.manage','newsletter.read','newsletter.edit','newsletter.send','mail.manage','operations.read','operations.retry','audit.read','reports.read_all','data_requests.manage','exports.create','withdrawals.manage'],
  superadmin: ['roles.manage','payments.configure','settings.manage','legal.manage'],
};
rights.superadmin = [...new Set(Object.values(rights).flat())];
const names: Record<string,string> = { participant:'Teilnehmer', support:'Kundenservice', instructor:'Dozent', course_manager:'Kursmanager', admin:'Administrator', superadmin:'Superadministrator' };
const templates: Record<string,{subject:string;text:string}> = {
  activation: { subject:'Aktiviere dein Konto', text:'Hallo {{first_name}},\n\nbitte öffne den folgenden Link und lege dein Passwort selbst fest:\n{{activation_url}}\n\nDer Link ist 24 Stunden gültig und kann nur einmal verwendet werden. Falls du kein Konto angefordert hast, ignoriere diese Nachricht.' },
  password_reset: { subject:'Passwort zurücksetzen', text:'Hallo {{first_name}},\n\nüber diesen Link kannst du dein Passwort zurücksetzen:\n{{reset_url}}\n\nDer Link ist 30 Minuten gültig und kann nur einmal verwendet werden. Falls du das nicht angefordert hast, ignoriere diese Nachricht.' },
  email_change: { subject:'Neue E-Mail-Adresse bestätigen', text:'Hallo {{first_name}},\n\nbitte bestätige deine neue E-Mail-Adresse über diesen Link:\n{{email_change_url}}\n\nDer Link ist 30 Minuten gültig und kann nur einmal verwendet werden.' },
  certificate_ready: { subject:'Deine Urkunde steht bereit', text:'Hallo {{first_name}},\n\ndeine Urkunde steht in deinem Konto unter „Meine Urkunden“ zum Download bereit.' },
  password_changed: { subject:'Dein Passwort wurde geändert', text:'Hallo {{first_name}},\n\ndas Passwort für dein Konto wurde geändert. Falls du das nicht selbst warst, kontaktiere den Betreiber.' },
  order_placed: { subject:'Bestellung {{order_number}} ist eingegangen', text:'Hallo {{first_name}},\n\nvielen Dank für deine Bestellung {{order_number}} über {{total}} EUR.\n\nBitte überweise den Betrag unter Angabe der Referenz {{payment_reference}} auf das im Konto genannte Konto. Sobald der Zahlungseingang gebucht ist, steht dir der Inhalt in deinem Konto zur Verfügung.' },
  order_paid: { subject:'Zahlungseingang zu {{order_number}}', text:'Hallo {{first_name}},\n\nwir haben deine Zahlung zur Bestellung {{order_number}} verbucht. Dein Zugang ist jetzt in deinem Konto freigeschaltet.' },
  refund_confirmed: { subject:'Erstattung zu {{order_number}}', text:'Hallo {{first_name}},\n\nwir haben dir {{total}} EUR zur Bestellung {{order_number}} zurückerstattet. Die Gutschrift {{credit_note_number}} findest du in deinem Konto.\n\nOb ein bereits freigeschalteter Kurszugang bestehen bleibt, entscheidet unser Team und meldet sich bei Bedarf. Andere Kurse sind davon nicht betroffen.' },
  withdrawal_received: { subject:'Dein Widerruf ist eingegangen', text:'Hallo {{first_name}},\n\nwir haben deinen Widerruf am {{received_date}} um {{received_time}} Uhr (UTC) erhalten und dauerhaft dokumentiert.\n\nWir prüfen den Vorgang und melden uns mit dem Ergebnis. Ein Widerruf löst nicht automatisch eine Erstattung aus; falls eine fällig wird, erhältst du einen eigenen Beleg.\n\nBewahre diese Nachricht als Bestätigung auf.' },
  withdrawal_verify: { subject:'Bestätige deine Adresse für den Widerruf', text:'Hallo {{first_name}},\n\nbitte bestätige über diesen Link die Adresse, von der der Widerruf eingegangen ist:\n\n{{verification_url}}\n\nDer Link ist 30 Minuten gültig und kann nur einmal verwendet werden. Erst danach kann der Vorgang {{request_reference}} einer Bestellung zugeordnet werden. Falls du keinen Widerruf erklärt hast, ignoriere diese Nachricht.' },
  withdrawal_decided: { subject:'Ergebnis zu deinem Widerruf', text:'Hallo {{first_name}},\n\nzu deinem Widerruf liegt jetzt eine Entscheidung vor: {{decision}}.\n\nFalls eine Erstattung erfolgt ist, findest du die Gutschrift in deinem Konto. Bei Rückfragen antworte einfach auf diese Nachricht.' },
  checkout_email_verify: { subject:'Bestätige deine E-Mail-Adresse für die Bestellung', text:'Hallo,\n\nbitte bestätige diese E-Mail-Adresse, damit wir deine Bestellung annehmen können. Öffne dafür diesen Link:\n\n{{verify_url}}\n\nAlternativ kannst du diesen Code eingeben: {{code}}\n\nDer Link ist 30 Minuten gültig. Wenn du nichts bestellt hast, ignoriere diese Nachricht einfach.' },
  dispute_opened: { subject:'Rückbuchung zu {{order_number}} – Frist prüfen', text:'Hallo {{first_name}},\n\nzu Bestellung {{order_number}} hat der Zahlungsanbieter eine Rückbuchung gemeldet: {{amount}} EUR, Grund {{reason}}, Stand {{status}}.\n\nBitte prüfe den Fall im Backoffice unter Streitfälle. Der Zugang wurde nicht automatisch entzogen; über den Zugang entscheidet ein Mensch.\n\nDiese Nachricht ist eine interne Meldung, keine Kundenmail.' },
  email_changed_old: { subject:'Deine Konto-E-Mail-Adresse wurde geändert', text:'Hallo {{first_name}},\n\ndie E-Mail-Adresse deines Kontos wurde geändert. Falls du das nicht selbst warst, kontaktiere den Betreiber.' },
};

export async function seedCatalog(db: PrismaClient): Promise<void> {
  await db.$transaction(async tx => {
    const allPermissions = [...new Set(Object.values(rights).flat())].sort();
    for (const key of allPermissions) await tx.permission.upsert({ where: { key }, create: { id: uuidv7(), key, description: key }, update: {} });
    for (const [key, list] of Object.entries(rights)) {
      const role = await tx.role.upsert({ where: { key }, create: { id: uuidv7(), key, name: names[key], is_system: true }, update: {} });
      const permissions = await tx.permission.findMany({ where: { key: { in: list } } });
      for (const permission of permissions) await tx.rolePermission.upsert({
        where: { role_id_permission_id: { role_id: role.id, permission_id: permission.id } },
        create: { role_id: role.id, permission_id: permission.id }, update: {},
      });
    }
    for (const [key, content] of Object.entries(templates)) {
      const template = await tx.emailTemplate.upsert({ where: { key_locale: { key, locale: 'de-DE' } },
        create: { id: uuidv7(), key, locale: 'de-DE', status: 'active' }, update: {} });
      const existing = await tx.emailTemplateVersion.findUnique({ where: { template_id_version: { template_id: template.id, version: 1 } } });
      if (!existing) {
        await tx.emailTemplateVersion.create({ data: {
          id: uuidv7(), template_id: template.id, version: 1, state: 'published', published_at: new Date(),
          subject_template: content.subject, body_text_template: content.text, body_html_template: content.text,
          allowed_variables: [
            { name: 'first_name', type: 'text', secrecy: 'personal' },
            ...(key === 'activation' ? [{ name:'activation_url', type:'url', secrecy:'secret' }] : []),
            ...(key === 'password_reset' ? [{ name:'reset_url', type:'url', secrecy:'secret' }] : []),
            ...(key === 'email_change' ? [{ name:'email_change_url', type:'url', secrecy:'secret' }] : []),
            ...(key === 'checkout_email_verify' ? [
              { name:'verify_url', type:'url', secrecy:'secret' },
              { name:'code', type:'text', secrecy:'secret' }] : []),
            ...(key === 'refund_confirmed' ? [
              { name:'credit_note_number', type:'text', secrecy:'public' }] : []),
            ...(key === 'withdrawal_received' ? [
              { name:'received_date', type:'text', secrecy:'public' },
              { name:'received_time', type:'text', secrecy:'public' }] : []),
            ...(key === 'withdrawal_verify' ? [
              { name:'verification_url', type:'url', secrecy:'secret' },
              { name:'request_reference', type:'text', secrecy:'public' }] : []),
            ...(key === 'withdrawal_decided' ? [
              { name:'decision', type:'text', secrecy:'public' }] : []),
            ...(key === 'dispute_opened' ? [
              { name:'order_number', type:'text', secrecy:'public' },
              { name:'amount', type:'text', secrecy:'public' },
              { name:'reason', type:'text', secrecy:'public' },
              { name:'status', type:'text', secrecy:'public' }] : []),
            ...(key === 'order_placed' || key === 'order_paid' || key === 'refund_confirmed' ? [
              { name:'order_number', type:'text', secrecy:'public' },
              { name:'total', type:'text', secrecy:'public' },
              { name:'payment_reference', type:'text', secrecy:'public' }] : []),
          ],
        } });
        await tx.auditEvent.create({ data: { id: uuidv7(), origin:'bootstrap', action:'mail_template.seeded', target_type:'email_template', target_ref:template.id } });
      }
    }
  }, { timeout: 30_000 });
}
