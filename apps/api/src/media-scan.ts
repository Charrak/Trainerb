import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { AwsClient } from 'aws4fetch';
import { Prisma, type PrismaClient, type CourseMediaUpload } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import type { Config } from './config';

type Receipt = Pick<CourseMediaUpload, 'id' | 'object_key' | 'size_bytes' | 'sha256'>;
type Verdict = { status: 'clean' | 'infected'; scan_error: null } |
  { status: 'scan_error'; scan_error: 'scanner' | 'storage' | 'integrity' };

/** clamd's local Unix socket, zINSTREAM with network-order lengths and a NUL-terminated reply. */
export function scanBytes(bytes: Buffer, path: string): Promise<'clean' | 'infected'> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const fail = () => { socket.destroy(); reject(new Error('Scanner unavailable or invalid reply')); };
    const deadline = setTimeout(fail, 20_000);
    socket.once('close', () => { clearTimeout(deadline); reject(new Error('Scanner closed without a verdict')); });
    socket.on('error', fail);
    let reply = '';
    socket.on('data', (chunk: Buffer) => {
      reply += chunk.toString('latin1');
      if (reply.length > 4096) return fail();
      if (!reply.includes('\0')) return;
      if (reply === 'stream: OK\0') resolve('clean');
      else if (/^stream: [^\x00-\x1f]+ FOUND\x00$/.test(reply)) resolve('infected');
      else return fail();
      socket.destroy();
    });
    socket.once('connect', () => {
      socket.write('zINSTREAM\0');
      const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
      socket.write(size); socket.write(bytes); socket.write(Buffer.alloc(4));
    });
  });
}

export async function inspectUpload(row: Receipt, store: NonNullable<Config['mediaStore']>, socket: string): Promise<Verdict> {
  let bytes: Buffer;
  try {
    const client = new AwsClient({ ...store, service: 's3', retries: 0 });
    const response = await client.fetch(`${store.origin}/${store.bucket}/${row.object_key}`, {
      redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel(); return { status: 'scan_error', scan_error: 'storage' };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.length;
      if (total > row.size_bytes || total > 5 * 1024 * 1024) {
        await reader.cancel(); return { status: 'scan_error', scan_error: 'integrity' };
      }
      chunks.push(value);
    }
    bytes = Buffer.concat(chunks, total);
    if (total !== row.size_bytes || !createHash('sha256').update(bytes).digest().equals(row.sha256)) {
      return { status: 'scan_error', scan_error: 'integrity' };
    }
  } catch { return { status: 'scan_error', scan_error: 'storage' }; }
  try { return { status: await scanBytes(bytes, socket), scan_error: null }; }
  catch { return { status: 'scan_error', scan_error: 'scanner' }; }
}

// The scan holds only a receipt lock, not a course or user lock. Bounded I/O;
// a crash rolls back the result, and parallel jobs skip the in-flight receipt.
export async function scanNext(db: PrismaClient, inspect: (row: Receipt) => Promise<Verdict>, retryId?: string) {
  return db.$transaction(async tx => {
    const [row] = await tx.$queryRaw<Receipt[]>`SELECT id, object_key, size_bytes, sha256 FROM course_media_uploads
      WHERE ${retryId ? Prisma.sql`id = ${retryId}::uuid AND status = 'scan_error'` : Prisma.sql`status = 'pending_scan'`}
      ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!row) return null;
    const verdict = await inspect(row);
    await tx.courseMediaUpload.update({ where: { id: row.id }, select: { id: true }, data: { ...verdict, scanned_at: new Date() } });
    await tx.auditEvent.create({ select: { id: true }, data: { id: uuidv7(), origin: 'system', action: 'media.scanned',
      target_type: 'course_media_upload', target_ref: row.id, after_safe: verdict } });
    return { id: row.id, ...verdict };
  }, { timeout: 35_000 });
}
