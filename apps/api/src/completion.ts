import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';

export const qualificationProfile = 'qualification_84_v1';

/** Called in the grading transaction, after chapter progress, with the access row locked.
 * The curriculum defines the required set. Attempts and self-confirmed chapters alone
 * cannot establish completion. Never copy answers or solutions into the evidence. */
export async function recordQualification(tx: Prisma.TransactionClient, accessId: string, versionId: string, completedAt: Date) {
  const scope = { access_id: accessId, course_version_id: versionId };
  const progress = await tx.chapterProgress.findMany({ where: scope, select: { chapter_id: true, completed_at: true }, orderBy: { chapter_id: 'asc' } });
  if (progress.length !== 42) return;
  const version = await tx.courseVersion.findUniqueOrThrow({ where: { id: versionId }, select: {
    completion_profile: true, expected_module_count: true, expected_chapter_count: true, expected_exams_per_chapter: true,
    modules: { select: { chapters: { select: { _count: { select: { exams: true } } } } } },
  } });
  if (version.completion_profile !== qualificationProfile || version.expected_module_count !== 14 || version.expected_chapter_count !== 42 || version.expected_exams_per_chapter !== 2) return;
  const chapters = version.modules.flatMap(m => m.chapters);
  if (version.modules.length !== 14 || version.modules.some(m => !m.chapters.length) || chapters.length !== 42 || chapters.some(c => c._count.exams !== 2)) return;
  // Composite chapter/version foreign keys and unique (access,chapter) bind all 42 progress rows.
  const passes = await tx.examAttempt.findMany({ where: { ...scope, status: 'submitted', result: { passed: true } },
    distinct: ['exam_id'], orderBy: [{ exam_id: 'asc' }, { attempt_no: 'asc' }], select: { id: true, exam_id: true, submitted_at: true } });
  if (passes.length !== 84) return;
  await tx.completionRecord.createMany({ skipDuplicates: true, data: {
    id: uuidv7(), ...scope, completion_profile: qualificationProfile, completed_at: completedAt,
    evidence_snapshot: { chapters: progress.map(p => ({ id: p.chapter_id, completed_at: p.completed_at.toISOString() })),
      exams: passes.map(a => ({ id: a.exam_id, attempt_id: a.id, passed_at: a.submitted_at!.toISOString() })) },
  } });
}
