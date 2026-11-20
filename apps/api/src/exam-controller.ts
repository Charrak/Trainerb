import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ExamRunner } from './exam-runner';
import { Sessions, type ApiRequest } from './sessions';
import { RateLimiter } from './limiter';
import { bodyObject, requireUuid } from './security';

@Controller('enrollments/:accessId/exams/:examId/attempts')
export class ExamController {
  constructor(private readonly sessions: Sessions, private readonly exams: ExamRunner, private readonly limiter: RateLimiter) {}
  private async limit(req: ApiRequest, user: string, exam: string, action: 'start' | 'submit') {
    const id = requireUuid(exam).toLowerCase();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    await this.limiter.hit(`exam-${action}-source`, `${user}:${ip}`, 90, 60_000);
    await this.limiter.hit(`exam-${action}-user`, `${user}:${id}`, 20, 60_000);
  }
  @Get('current') async current(@Req() req: ApiRequest, @Param('accessId') a: string, @Param('examId') e: string) {
    return this.exams.current(await this.sessions.require(req, { permission: 'learning.use' }), a, e);
  }
  @Post() @HttpCode(200) async start(@Req() req: ApiRequest, @Param('accessId') a: string, @Param('examId') e: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { permission: 'learning.use' }); await this.sessions.verifyCsrf(req, ctx);
    bodyObject(body, []); await this.limit(req, ctx.user.id, e, 'start'); return this.exams.start(ctx, a, e, req.get('Idempotency-Key'));
  }
  @Post(':id/submit') @HttpCode(200) async submit(@Req() req: ApiRequest, @Param('accessId') a: string, @Param('examId') e: string, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { permission: 'learning.use' }); await this.sessions.verifyCsrf(req, ctx);
    await this.limit(req, ctx.user.id, e, 'submit');
    return this.exams.submit(ctx, a, e, id, body, req.get('Idempotency-Key'));
  }
}
