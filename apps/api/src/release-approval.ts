import { createPublicKey, verify } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { getConfig } from './config';
/** Signed by operations, not by the application. Never store a release signing key in the runtime. */
export const evidenceAreas = [
  'operator',
  'legal_tax_zfu',
  'courses_and_rights',
  'payments',
  'mail',
  'media',
  'privacy_accessibility',
  'monitoring_support',
  'restore_rollback',
  'end_to_end',
] as const;
export function verifyApproval(
  bytes: Buffer,
  signature: Buffer,
  publicKey: string,
  origin: string,
  commit: string,
  now = Date.now(),
) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      bytes.length > 16384 ||
      signature.length !== 64 ||
      !verify(null, bytes, key, signature)
    )
      return false;
    const r = JSON.parse(bytes.toString('utf8'));
    if (
      r.version !== 1 ||
      r.scope !== 'trainerb.production.new-sales' ||
      r.origin !== origin ||
      !origin.startsWith('https://') ||
      !/^([0-9a-f]{40})$/.test(commit) ||
      r.commit !== commit ||
      !r.evidence ||
      Array.isArray(r.evidence)
    )
      return false;
    const start = Date.parse(r.valid_from),
      end = Date.parse(r.valid_until);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      r.valid_from !== new Date(start).toISOString() ||
      r.valid_until !== new Date(end).toISOString() ||
      !(start <= now && now < end && end - start <= 90 * 86400000)
    )
      return false;
    return evidenceAreas.every((k) => typeof r.evidence[k] === 'string' && /^[a-f0-9]{64}$/.test(r.evidence[k]));
  } catch {
    return false;
  }
}
async function bounded(path: string, max: number) {
  const fh = await open(path, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size < 1 || st.size > max) throw Error();
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fh.read(buf);
    if (bytesRead !== st.size) throw Error();
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
export async function approvedForNewSales() {
  const cfg = getConfig();
  if (cfg.appEnv !== 'production') return true;
  const { RELEASE_APPROVAL_FILE: file, RELEASE_VERIFY_KEY: pub, RELEASE_COMMIT: commit } = process.env;
  if (!file || !isAbsolute(file) || !pub || !commit) return false;
  try {
    const [bytes, sig] = await Promise.all([bounded(file, 16384), bounded(file + '.sig', 64)]);
    return verifyApproval(bytes, sig, pub, cfg.publicBaseUrl, commit);
  } catch {
    return false;
  }
}
