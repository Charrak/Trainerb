import {templates} from '../mail-catalog';
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
            ...(key === 'course_expiry' ? [{name:'course_title',type:'text',secrecy:'public'},{name:'ends_at',type:'text',secrecy:'public'}] : []),
            ...(key === 'newsletter_confirm' ? [{name:'topic',type:'text',secrecy:'public'},{name:'wording',type:'text',secrecy:'public'},{name:'confirm_url',type:'url',secrecy:'secret'}] : []),
            ...(key === 'newsletter_campaign' ? [{name:'subject',type:'text',secrecy:'public'},{name:'body',type:'text',secrecy:'public'},{name:'leave_url',type:'url',secrecy:'secret'}] : []),
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
            ...(key === 'card_order_placed' ? [{name:'order_number',type:'text',secrecy:'public'},{name:'total',type:'text',secrecy:'public'}] : []),
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
