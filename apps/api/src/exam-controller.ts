import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ExamRunner } from './exam-runner';
import { Sessions, type ApiRequest } from './sessions';
import { bodyObject } from './security';

@Controller('enrollments/:accessId/exams/:examId/attempts')
export class ExamController {
  constructor(private readonly sessions: Sessions, private readonly exams: ExamRunner) {}
  @Get('current') async current(@Req() req: ApiRequest, @Param('accessId') a: string, @Param('examId') e: string) {
    return this.exams.current(await this.sessions.require(req, { permission: 'learning.use' }), a, e);
  }
  @Post() @HttpCode(200) async start(@Req() req: ApiRequest, @Param('accessId') a: string, @Param('examId') e: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { permission: 'learning.use' }); await this.sessions.verifyCsrf(req, ctx);
    bodyObject(body, []); return this.exams.start(ctx, a, e, req.get('Idempotency-Key'));
  }
  @Post(':id/submit') @HttpCode(200) async submit(@Req() req: ApiRequest, @Param('accessId') a: string, @Param('examId') e: string, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { permission: 'learning.use' }); await this.sessions.verifyCsrf(req, ctx);
    return this.exams.submit(ctx, a, e, id, body, req.get('Idempotency-Key'));
  }
}
