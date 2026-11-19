import { createHash } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { getConfig } from './config';
import { Outbox } from './outbox';
import { randomToken, seal } from './security';
import { certificatePdf, type CertificateSnapshot } from './certificate-pdf';

/** PostgreSQL is the private document store and durable work queue. Hold the account,
 * grant and job locks through local rendering and commit; no network I/O during issuance. */
export async function issueNextCertificate(db: Database, outbox: Outbox, render = certificatePdf) {
  let job: string | undefined;
  try {
    return await db.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<
          {
            id: string;
            user_id: string;
            status: string;
            email_original: string | null;
            first_name: string | null;
            last_name: string | null;
            heading: string;
            issuer: string;
            title: string;
            version: number;
            completed_at: Date;
          }[]
        >`
        SELECT c.id,u.id AS user_id,u.status,u.email_original,u.first_name,u.last_name,t.heading,t.issuer,v.title,v.version,r.completed_at
        FROM certificates c JOIN completion_records r ON r.id=c.completion_id JOIN course_access a ON a.id=r.access_id
        JOIN users u ON u.id=a.user_id JOIN course_versions v ON v.id=c.course_version_id JOIN certificate_templates t ON t.id=c.template_id
        WHERE c.status='queued' AND c.retry_at<=now() AND t.approved_at IS NOT NULL AND
          (u.status='deleted' OR (u.status='active' AND a.revoked_at IS NULL AND a.suspended_at IS NULL))
        ORDER BY c.retry_at,c.id LIMIT 1 FOR UPDATE OF c,u,a SKIP LOCKED`;
        if (!row) return false;
        job = row.id;
        if (row.status === 'deleted') {
          await tx.certificate.update({ where: { id: row.id }, data: { status: 'cancelled' } });
          return true;
        }
        if (!row.first_name || !row.last_name || !row.email_original) throw new Error('MISSING_IDENTITY');
        const token = randomToken(),
          cfg = getConfig();
        const snapshot: CertificateSnapshot = {
          first_name: row.first_name,
          last_name: row.last_name,
          heading: row.heading,
          issuer: row.issuer,
          title: row.title,
          version: row.version,
          completed_on: row.completed_at.toISOString().slice(0, 10),
          number: row.id,
          verification_url: `${cfg.publicBaseUrl}/zertifikat-pruefen`,
          token,
        };
        const pdf = await render(snapshot);
        await tx.certificate.update({
          where: { id: row.id },
          data: {
            status: 'valid',
            issued_at: new Date(),
            verification_hash: createHash('sha256').update(token).digest(),
            last_error: null,
            key_id: cfg.encryptionKeyId,
            document_ciphertext: seal({ snapshot, pdf: pdf.toString('base64') }, `certificate:${row.id}`),
          },
        });
        await tx.auditEvent.create({
          data: {
            id: uuidv7(),
            origin: 'system',
            action: 'certificate.issued',
            target_type: 'certificate',
            target_ref: row.id,
          },
        });
        await outbox.notify(tx, row.user_id, row.email_original, row.first_name, 'certificate_ready');
        return true;
      },
      { timeout: 15000 },
    );
  } catch (error) {
    if (job)
      await db.certificate.updateMany({
        where: { id: job, status: 'queued' },
        data: { attempts: { increment: 1 }, last_error: 'ISSUANCE_FAILED', retry_at: new Date(Date.now() + 60000) },
      });
    throw error;
  }
}
