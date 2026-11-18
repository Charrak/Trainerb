import { AwsClient } from 'aws4fetch';
import type { MediaAsset } from '@prisma/client';
import type { Config } from './config';

export const deliveryFields = { source: true, storage_key: true, visibility: true, status: true, mime_detected: true } as const;
export type DeliveryAsset = Pick<MediaAsset, keyof typeof deliveryFields>;

// Use the same allowlist for publication and retrieval. Never render active
// document formats inline; generic files are forced to a binary download.
export function deliverable(kind: string, asset: DeliveryAsset | null): asset is DeliveryAsset & { storage_key: string } {
  return !!asset && asset.source === 's3' && asset.status === 'ready' && asset.visibility === 'private' &&
    !!asset.storage_key && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(asset.storage_key) &&
    (kind === 'file' || (kind === 'image' && ['image/jpeg','image/png','image/webp','image/gif'].includes(asset.mime_detected)) ||
      (kind === 'video' && ['video/mp4','video/webm'].includes(asset.mime_detected)));
}

export async function signLessonGet(store: NonNullable<Config['mediaStore']>, key: string, kind: string, mime: string, ttl: number) {
  const url = new URL(`/${store.bucket}/${key}`, store.origin);
  url.searchParams.set('X-Amz-Expires', String(ttl));
  url.searchParams.set('response-cache-control', 'private, no-store');
  url.searchParams.set('response-content-type', kind === 'file' ? 'application/octet-stream' : mime);
  url.searchParams.set('response-content-disposition', kind === 'file' ? 'attachment' : 'inline');
  return (await new AwsClient({ ...store, service: 's3' }).sign(url, { method: 'GET', aws: { signQuery: true } })).url;
}
