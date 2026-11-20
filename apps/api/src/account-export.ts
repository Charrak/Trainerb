import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type ApiRequest } from './sessions';
import { apiError, bodyObject, requireUuid } from './security';
import { RateLimiter } from './limiter';
// Explicit projections: never serialize raw account rows, exams, documents or provider payloads.
function sections(id: string) {
  return {
    profile: Prisma.sql`SELECT id,first_name,last_name,email_original AS email,email_verified_at,locale,status,created_at,last_login_at FROM users WHERE id=${id}::uuid`,
    billing: Prisma.sql`SELECT id,company,first_name,last_name,street,street_extra,postal_code,city,region,country,vat_id,is_default,archived_at FROM billing_profiles WHERE user_id=${id}::uuid`,
    orders: Prisma.sql`SELECT id,order_number,currency,total_gross_cents::text,payment_method,payment_state,fulfillment_state,placed_at,paid_at FROM orders WHERE user_id=${id}::uuid`,
    acceptances: Prisma.sql`SELECT a.id,a.order_id,a.legal_document_version_id,a.kind,a.affirmed,a.created_at FROM order_legal_acceptances a JOIN orders o ON o.id=a.order_id WHERE o.user_id=${id}::uuid`,
    invoices: Prisma.sql`SELECT i.id,i.order_id,i.invoice_number,i.issued_at,i.total_gross_cents::text,i.currency FROM invoices i JOIN orders o ON o.id=i.order_id WHERE o.user_id=${id}::uuid`,
    credits: Prisma.sql`SELECT i.id,i.order_id,i.document_number,i.issued_at,i.total_gross_cents::text,i.currency FROM credit_notes i JOIN orders o ON o.id=i.order_id WHERE o.user_id=${id}::uuid`,
    access: Prisma.sql`SELECT a.id,a.course_id,a.course_version_id,v.title,a.source,a.starts_at,a.ends_at,a.revoked_at,a.suspended_at FROM course_access a JOIN course_versions v ON v.id=a.course_version_id WHERE a.user_id=${id}::uuid`,
    progress: Prisma.sql`SELECT p.id,p.access_id,p.chapter_id,p.completed_at FROM chapter_progress p JOIN course_access a ON a.id=p.access_id WHERE a.user_id=${id}::uuid`,
    exams: Prisma.sql`SELECT e.id,e.access_id,e.exam_id,e.attempt_no,e.status,e.started_at,e.submitted_at,r.passed,r.correct_count FROM exam_attempts e JOIN course_access a ON a.id=e.access_id LEFT JOIN exam_attempt_results r ON r.attempt_id=e.id WHERE a.user_id=${id}::uuid`,
    completions: Prisma.sql`SELECT r.id,r.access_id,r.completed_at,r.completion_profile FROM completion_records r JOIN course_access a ON a.id=r.access_id WHERE a.user_id=${id}::uuid`,
    certificates: Prisma.sql`SELECT c.id,c.completion_id,c.status,c.issued_at,c.revoked_at FROM certificates c JOIN completion_records r ON r.id=c.completion_id JOIN course_access a ON a.id=r.access_id WHERE a.user_id=${id}::uuid`,
  };
}
@Controller()
export class AccountExport {
  constructor(
    private readonly db: Database,
    private readonly sessions: Sessions,
    private readonly limiter: RateLimiter,
  ) {}
  @Post('me/export') @HttpCode(200) async read(@Req() req: ApiRequest, @Body() input: unknown) {
    const ctx = await this.sessions.require(req, { fresh: true });
    await this.sessions.verifyCsrf(req, ctx);
    await this.limiter.hit('account-export', ctx.user.id, 120, 60000);
    const b = bodyObject(input, ['section', 'after']),
      queries = sections(ctx.user.id);
    if (typeof b.section !== 'string' || !Object.hasOwn(queries, b.section))
      throw apiError(422, 'INVALID_SECTION', 'Datenbereich unbekannt.');
    const section = b.section as keyof typeof queries,
      after = b.after === undefined ? null : requireUuid(String(b.after));
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${ctx.user.id}::uuid FOR UPDATE`;
      const current = await this.sessions.assertCurrent(tx, ctx);
      if (!current.reauthenticated_at || Date.now() - current.reauthenticated_at.getTime() > 300000)
        throw apiError(403, 'REAUTH_REQUIRED', 'Bitte erneut bestätigen.');
      const rows = await tx.$queryRaw<Array<{ id: string } & Record<string, unknown>>>(
        Prisma.sql`SELECT d.* FROM (${queries[section]}) d ${after ? Prisma.sql`WHERE d.id>${after}::uuid` : Prisma.empty} ORDER BY d.id LIMIT 101`,
      );
      await tx.auditEvent.create({
        data: {
          id: uuidv7(),
          actor_user_id: ctx.user.id,
          origin: 'user',
          action: 'privacy.self_export',
          target_type: 'user',
          target_ref: ctx.user.id,
          after_safe: { section, count: Math.min(rows.length, 100) },
        },
      });
      return {
        schema_version: 1,
        section,
        as_of: new Date(),
        data: rows.slice(0, 100),
        next_cursor: rows.length > 100 ? rows[99].id : null,
      };
    });
  }
}
