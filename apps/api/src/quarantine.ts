import { createHash, randomUUID } from 'node:crypto';
import express, { type Response } from 'express';
import { AwsClient } from 'aws4fetch';
import { getConfig } from './config';
import { apiError } from './security';
import type { ApiRequest } from './sessions';

const maxBytes = 5 * 1024 * 1024;
const invalid = () => apiError(422, 'INVALID_UPLOAD', 'Bitte eine PNG-, JPEG- oder PDF-Datei mit passender Dateiendung auswählen.');
// Signature detection is only an intake filter, not a malware or safety verdict.
function detect(bytes: Buffer) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString('latin1', 12, 16) === 'IHDR') return 'image/png';
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
      bytes.readUInt16BE(bytes.length - 2) === 0xffd9) return 'image/jpeg';
  if (/^%PDF-\d\.\d/.test(bytes.toString('latin1', 0, 8)) && bytes.subarray(-1024).includes('%%EOF')) return 'application/pdf';
  throw invalid();
}

export async function quarantineFile(req: ApiRequest, res: Response) {
  const store = getConfig().quarantineStore;
  if (!store) throw apiError(503, 'QUARANTINE_DISABLED', 'Der Quarantänespeicher ist nicht eingerichtet.');
  if (!req.is('application/octet-stream') || req.get('content-encoding')) throw apiError(415, 'UPLOAD_FORMAT', 'Binärdatei ohne Kompression erwartet.');
  let name: string;
  try { name = decodeURIComponent(req.get('x-upload-name') ?? '').normalize('NFC').trim(); } catch { throw invalid(); }
  if (!name || name.length > 160 || /[\\/\p{C}]/u.test(name)) throw invalid();
  // Parse only after session, CSRF, rate and course checks. The byte limit
  // applies to chunked bodies as well as requests carrying Content-Length.
  await new Promise<void>((resolve, reject) => express.raw({ type: 'application/octet-stream', limit: maxBytes, inflate: false })(req, res,
    err => err ? reject(err.type === 'entity.too.large' ? apiError(413, 'UPLOAD_TOO_LARGE', 'Maximal 5 MiB pro Datei.') : invalid()) : resolve()));
  const bytes: Buffer = req.body;
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw invalid();
  const mime = detect(bytes);
  if (!(mime === 'image/png' ? /\.png$/i : mime === 'image/jpeg' ? /\.jpe?g$/i : /\.pdf$/i).test(name)) throw invalid();
  const objectKey = randomUUID();
  const metadata = { object_key: objectKey, original_name: name, mime_detected: mime, size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest() };
  try {
    const writer = new AwsClient({ ...store, service: 's3', retries: 0 });
    const response = await writer.fetch(`${store.origin}/${store.bucket}/${objectKey}`, { method: 'PUT', body: new Uint8Array(bytes),
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' },
      redirect: 'error', signal: AbortSignal.timeout(8000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Storage rejected PUT');
  } catch { throw apiError(503, 'QUARANTINE_UNAVAILABLE', 'Die Datei konnte nicht in Quarantäne gespeichert werden.'); }
  return metadata;
}
