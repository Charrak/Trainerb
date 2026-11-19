import { qualificationProfile, recordQualification } from './completion';
import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type SessionContext } from './sessions';
import { apiError, bodyObject, requireUuid } from './security';

type Tx = Prisma.TransactionClient;
const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
const conflict = () => apiError(409, 'ATTEMPT_CONFLICT', 'Der Versuch hat sich geändert. Bitte lade ihn neu.');
const invalid = () => apiError(422, 'INVALID_ANSWERS', 'Wähle für jede angezeigte Frage genau eine ihrer Antworten.');
function shuffle<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; --i) { const j = randomInt(i + 1); [items[i], items[j]] = [items[j], items[i]]; }
  return items;
}
function key(value?: string) {
  if (!value || !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value)) throw apiError(422, 'INVALID_KEY', 'Ein gültiger Idempotenzschlüssel ist erforderlich.');
  return value.toLowerCase();
}
const paper = { questions: { orderBy: { position: 'asc' }, include: { options: { orderBy: { position: 'asc' } } } }, result: true } as const;
type Attempt = Prisma.ExamAttemptGetPayload<{ include: typeof paper }>;
function view(a: Attempt) {
  if (a.status === 'submitted' && a.result) {
    if (!a.result.passed) return { id: a.id, status: 'failed' as const };
    return { id: a.id, status: 'passed' as const, solutions: a.questions.map(q => ({ text: q.prompt, explanation: q.rationale,
      answer: q.options.find(o => o.correct)?.label })) };
  }
  if (a.status !== 'in_progress' || a.questions.length !== 3 || a.questions.some(q => !q.prompt || !q.rationale || q.options.length !== 4 ||
    q.options.some(o => !o.label || o.correct === null) || q.options.filter(o => o.correct).length !== 1)) throw conflict();
  return { id: a.id, status: 'in_progress' as const, questions: a.questions.map(q => ({ id: q.question_id, text: q.prompt!,
    options: q.options.map(o => ({ id: o.option_id, text: o.label! })) })) };
}
@Injectable()
export class ExamRunner {
  constructor(private readonly db: Database, private readonly sessions: Sessions) {}
  private async scope(tx: Tx, ctx: SessionContext, accessId: string, examId: string) {
    requireUuid(accessId); requireUuid(examId);
    await this.sessions.assertCurrent(tx, ctx);
    // All starts/submissions for this grant serialize with each other and suspensions.
    await tx.$queryRaw`SELECT id FROM course_access WHERE id=${accessId}::uuid AND user_id=${ctx.user.id}::uuid FOR UPDATE`;
    const a = await tx.courseAccess.findFirst({ where: { id: accessId, user_id: ctx.user.id, revoked_at: null }, select: {
      course_version_id: true, suspended_at: true, starts_at: true, ends_at: true, version: { select: { chapter_completion_mode: true, completion_profile: true, state: true } } } });
    if (!a || a.version.state === 'draft') throw missing();
    const checkedAt = new Date();
    if (a.suspended_at || a.starts_at > checkedAt || (a.ends_at && a.ends_at <= checkedAt)) throw apiError(403, 'ACCESS_INACTIVE', 'Kein gültiger Kurszugang.');
    const exam = await tx.exam.findFirst({ where: { id: examId, course_version_id: a.course_version_id }, select: { chapter_id: true } });
    if (!exam) throw missing();
    return { checkedAt, versionId: a.course_version_id, profile: a.version.completion_profile, mode: a.version.chapter_completion_mode, chapterId: exam.chapter_id };
  }
  async current(ctx: SessionContext, accessId: string, examId: string) {
    return this.db.$transaction(async tx => {
      await this.scope(tx, ctx, accessId, examId);
      const a = await tx.examAttempt.findFirst({ where: { access_id: accessId, exam_id: examId, status: { not: 'expired' } }, orderBy: { attempt_no: 'desc' }, include: paper });
      return { attempt: a ? view(a) : null };
    });
  }
  async start(ctx: SessionContext, accessId: string, examId: string, header?: string) {
    const startKey = key(header);
    return this.db.$transaction(async tx => {
      const { versionId } = await this.scope(tx, ctx, accessId, examId);
      const replay = await tx.examAttempt.findUnique({ where: { access_id_start_idempotency_key: { access_id: accessId, start_idempotency_key: startKey } }, include: paper });
      if (replay) { if (replay.exam_id !== examId) throw conflict(); return view(replay); }
      const last = await tx.examAttempt.findFirst({ where: { access_id: accessId, exam_id: examId }, orderBy: { attempt_no: 'desc' }, include: paper });
      if (last && (last.status === 'in_progress' || last.result?.passed)) throw conflict();
      const pool = await tx.question.findMany({ where: { exam_id: examId, status: 'active' }, include: { options: true } });
      const eligible = shuffle(pool.filter(q => q.explanation.trim() && q.options.length === 4 && q.options.filter(o => o.is_correct).length === 1));
      if (eligible.length < 3) throw apiError(409, 'EXAM_NOT_READY', 'Für diese Prüfung fehlen freigegebene Fragen.');
      const used = new Set((await tx.examAttemptQuestion.findMany({ where: { exam_id: examId, attempt: { access_id: accessId } }, distinct: ['question_id'], select: { question_id: true } })).map(q => q.question_id));
      const selected = shuffle(eligible.sort((a,b) => Number(used.has(a.id)) - Number(used.has(b.id))).slice(0, 3));
      const id = uuidv7();
      await tx.examAttempt.create({ data: { id, access_id: accessId, course_version_id: versionId, exam_id: examId, attempt_no: (last?.attempt_no ?? 0) + 1, start_idempotency_key: startKey } });
      for (const [i,q] of selected.entries()) {
        await tx.examAttemptQuestion.create({ data: { attempt_id: id, exam_id: examId, question_id: q.id, position: i+1, prompt: q.question_text, rationale: q.explanation } });
        await tx.examAttemptOption.createMany({ data: shuffle(q.options).map((o,j) => ({ attempt_id: id, question_id: q.id, option_id: o.id, position: j+1, label: o.option_text, correct: o.is_correct })) });
      }
      return view(await tx.examAttempt.findUniqueOrThrow({ where: { id }, include: paper }));
    });
  }
  async submit(ctx: SessionContext, accessId: string, examId: string, attemptId: string, input: unknown, header?: string) {
    requireUuid(attemptId); const submitKey = key(header), body = bodyObject(input, ['answers']);
    if (!Array.isArray(body.answers) || body.answers.length !== 3) throw invalid();
    const picks = new Map<string,string>();
    for (const item of body.answers) {
      const v = bodyObject(item, ['question_id','option_id']);
      if (typeof v.question_id !== 'string' || typeof v.option_id !== 'string') throw invalid();
      picks.set(v.question_id,v.option_id);
    }
    if (picks.size !== 3) throw invalid();
    return this.db.$transaction(async tx => {
      const { checkedAt, versionId, mode, chapterId, profile } = await this.scope(tx, ctx, accessId, examId);
      const a = await tx.examAttempt.findFirst({ where: { id: attemptId, access_id: accessId, exam_id: examId }, include: paper });
      if (!a) throw missing();
      if (a.result) {
        const stored = await tx.examAttemptAnswer.findMany({ where: { attempt_id: a.id } });
        if (a.result.submit_key !== submitKey || stored.length !== 3 || stored.some(s => picks.get(s.question_id) !== s.selected_option_id)) throw conflict();
        return view(a);
      }
      view(a); // rejects expired or incomplete legacy snapshots
      let correct = 0;
      const answers = a.questions.map(q => {
        const o = q.options.find(o => o.option_id === picks.get(q.question_id)); if (!o) throw invalid();
        if (o.correct) ++correct;
        return { attempt_id: a.id, question_id: q.question_id, selected_option_id: o.option_id };
      });
      await tx.examAttemptAnswer.createMany({ data: answers });
      await tx.examAttemptResult.create({ data: { attempt_id: a.id, submit_key: submitKey, correct_count: correct, passed: correct === 3 } });
      const done = await tx.examAttempt.update({ where: { id: a.id }, data: { status: 'submitted', submitted_at: checkedAt }, include: paper });
      if (correct === 3 && mode !== 'self_confirm' && !await tx.exam.count({ where: { chapter_id: chapterId, attempts: { none: { access_id: accessId, result: { passed: true } } } } })) {
        await tx.chapterProgress.upsert({ where: { access_id_chapter_id: { access_id: accessId, chapter_id: chapterId } },
          create: { id: uuidv7(), access_id: accessId, course_version_id: versionId, chapter_id: chapterId }, update: {} });
      }
      if (correct === 3 && profile === qualificationProfile) await recordQualification(tx, accessId, versionId, done.submitted_at!);
      return view(done);
    });
  }
}
