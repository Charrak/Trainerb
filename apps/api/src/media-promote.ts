import { randomUUID } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { Prisma, type PrismaClient, type CourseMediaUpload } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { readVerified } from './quarantine-read';
import type { promotionConfig } from './media-scan-config';

type JobStores = Pick<ReturnType<typeof promotionConfig>, 'source' | 'destination'>;
type Receipt = Pick<CourseMediaUpload, 'id' | 'original_name' | 'object_key' | 'sha256' | 'size_bytes' | 'mime_detected' | 'uploaded_by'>;

/** Lock one eligible receipt. A fresh key per PUT makes even an ambiguous network/DB
 * failure safe for existing assets. A private orphan may need offline cleanup. */
export async function promoteNext(db: PrismaClient, stores: JobStores, retryId?: string) {
  return db.$transaction(async tx => {
    const [row] = await tx.$queryRaw<Receipt[]>`SELECT id, original_name, object_key, sha256, size_bytes, mime_detected, uploaded_by
      FROM course_media_uploads WHERE status = 'clean' AND approved_at IS NOT NULL AND promoted_asset_id IS NULL
      AND ${retryId ? Prisma.sql`promotion_error IS NOT NULL AND id = ${retryId}::uuid` : Prisma.sql`promotion_error IS NULL`}
      ORDER BY approved_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!row) return null;
    const bytes = await readVerified(row, stores.source);
    const key = randomUUID();
    let error: 'storage' | 'integrity' | 'destination' | null = null;
    if (!Buffer.isBuffer(bytes)) error = bytes;
    else {
      const dest = stores.destination;
      try {
        const put = await new AwsClient({ ...dest, service: 's3', retries: 0 }).fetch(`${dest.origin}/${dest.bucket}/${key}`, {
          method: 'PUT', body: new Uint8Array(bytes), headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' },
          redirect: 'error', signal: AbortSignal.timeout(8000) });
        await put.body?.cancel();
        if (put.status !== 200) error = 'destination';
      } catch { error = 'destination'; }
    }
    let assetId: string | null = null;
    if (!error) {
      const asset = await tx.mediaAsset.create({ select: { id: true }, data: { id: uuidv7(), source: 's3', storage_key: key,
        original_name: row.original_name, mime_detected: row.mime_detected, size_bytes: row.size_bytes, sha256: row.sha256,
        uploaded_by: row.uploaded_by, status: 'ready', visibility: 'private' } });
      assetId = asset.id;
    }
    await tx.courseMediaUpload.update({ where: { id: row.id }, select: { id: true }, data: { promoted_asset_id: assetId, promotion_error: error } });
    await tx.auditEvent.create({ select: { id: true }, data: { id: uuidv7(), origin: 'system', target_type: 'course_media_upload', target_ref: row.id,
      action: error ? 'media.promotion_failed' : 'media.promoted', after_safe: { asset_id: assetId, error } } });
    return { upload_id: row.id, asset_id: assetId, error };
  }, { timeout: 25_000 });
}
