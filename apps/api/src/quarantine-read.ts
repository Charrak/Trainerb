import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import type { CourseMediaUpload } from '@prisma/client';
import type { Config } from './config';

export async function readVerified(row: Pick<CourseMediaUpload, 'object_key' | 'size_bytes' | 'sha256'>, store: NonNullable<Config['mediaStore']>): Promise<Buffer | 'storage' | 'integrity'> {
  let bytes: Buffer;
  try {
    const client = new AwsClient({ ...store, service: 's3', retries: 0 });
    const response = await client.fetch(`${store.origin}/${store.bucket}/${row.object_key}`, {
      redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel(); return 'storage';
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.length;
      if (total > row.size_bytes || total > 5 * 1024 * 1024) {
        await reader.cancel(); return 'integrity';
      }
      chunks.push(value);
    }
    bytes = Buffer.concat(chunks, total);
    if (total !== row.size_bytes || !createHash('sha256').update(bytes).digest().equals(row.sha256)) {
      return 'integrity';
    }
  } catch { return 'storage'; }
  return bytes;
}
