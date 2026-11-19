import { Controller, Get, Query, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { financeReport } from './finance-report';
import { Database } from './database';
import { Sessions, type ApiRequest } from './sessions';
import { apiError, bodyObject } from './security';

@Controller('admin/dashboard')
export class DashboardController {
  constructor(
    private readonly db: Database,
    private readonly sessions: Sessions,
  ) {}

  @Get('finance') async finance(@Req() req: ApiRequest, @Query() input: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'reports.read_all' });
    if (!ctx.roleKeys.some((r) => r === 'admin' || r === 'superadmin'))
      throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    const { period = 'today' } = bodyObject(input, ['period']);
    if (period !== 'today' && period !== 'month' && period !== 'all')
      throw apiError(422, 'INVALID_PERIOD', 'Ungültiger Berichtszeitraum.');
    return financeReport(this.db, period);
  }

  @Get() async counts(@Req() req: ApiRequest, @Query() input: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true });
    // The caller cannot supply a scope, user or course ID to broaden these counts.
    bodyObject(input, []);
    const global =
      ctx.permissionKeys.has('reports.read_all') && ctx.roleKeys.some((r) => ['superadmin', 'admin'].includes(r));
    const assigned =
      ctx.permissionKeys.has('reports.read_assigned') &&
      ctx.roleKeys.some((r) => ['course_manager', 'instructor'].includes(r));
    if (!global && !assigned) {
      if (!ctx.permissionKeys.has('reports.read_basic')) throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
      const public_courses = await this.db.course.count({
        where: { status: 'published', visibility: 'public', versions: { some: { state: 'published' } } },
      });
      return { scope: 'basic', public_courses };
    }
    const roles = [
      ...(ctx.roleKeys.includes('course_manager') ? ['manager'] : []),
      ...(ctx.roleKeys.includes('instructor') ? ['instructor'] : []),
    ];
    const scope = global
      ? Prisma.empty
      : Prisma.sql`WHERE EXISTS (SELECT 1 FROM course_staff s WHERE s.course_id=c.id
      AND s.user_id=${ctx.user.id}::uuid AND s.scope_role IN (${Prisma.join(roles)}))`;
    // Count the completion record, not passes, attempts or issued/reissued certificates.
    const [row] = await this.db.$queryRaw<
      { courses: number; completions: number }[]
    >`WITH visible AS (SELECT c.id FROM courses c ${scope})
      SELECT (SELECT count(*)::int FROM visible) AS courses,
        (SELECT count(*)::int FROM completion_records r JOIN course_versions v ON v.id=r.course_version_id JOIN visible c ON c.id=v.course_id) AS completions`;
    return { scope: global ? 'global' : 'assigned', ...row };
  }
}
