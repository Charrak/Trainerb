import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { HttpException } from '@nestjs/common';
import { normalizePersonName } from '@trainerb/contracts';
import { getConfig } from './config';

export function randomToken(): string { return randomBytes(32).toString('base64url'); }
export function keyedHash(key: Buffer, context: string, value: string): Buffer<ArrayBuffer> {
  return createHmac('sha256', key).update(context).update('\0').update(value).digest();
}
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function seal(value: unknown, aad: string): Buffer<ArrayBuffer> {
  const key = getConfig().encryptionKey;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}
export function unseal<T>(value: Uint8Array, aad: string, keyId: string): T {
  const cfg = getConfig();
  if (keyId !== cfg.encryptionKeyId || value.length < 29) throw new Error('Unavailable encryption key or invalid ciphertext.');
  const bytes = Buffer.from(value);
  const decipher = createDecipheriv('aes-256-gcm', cfg.encryptionKey, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as T;
}

export function bodyObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw apiError(400, 'INVALID_REQUEST', 'Ungültige Anfrage.');
  const obj = input as Record<string, unknown>;
  if (Object.keys(obj).some(k => !allowed.includes(k))) throw apiError(400, 'INVALID_REQUEST', 'Die Anfrage enthält unbekannte Felder.');
  return obj;
}
export function apiError(status: number, code: string, message: string, details?: Record<string, string>): HttpException {
  return new HttpException({ code, message, ...(details ? { details } : {}) }, status);
}
export function requireName(input: unknown, field: 'first_name' | 'last_name'): string {
  const result = normalizePersonName(input);
  if (!result.ok) throw apiError(422, 'INVALID_NAME', 'Bitte prüfe deine Namensangaben.', { [field]: result.message });
  return result.value;
}
export function normalizeEmail(input: unknown): { original: string; canonical: string } {
  if (typeof input !== 'string') throw apiError(422, 'INVALID_EMAIL', 'Bitte gib eine gültige E-Mail-Adresse ein.', { email: 'E-Mail-Adresse erforderlich.' });
  const original = input.trim();
  const parts = original.split('@');
  if (parts.length !== 2 || Buffer.byteLength(original, 'utf8') > 254 || /[\p{White_Space}\p{Cc}]/u.test(original)) {
    throw apiError(422, 'INVALID_EMAIL', 'Bitte gib eine gültige E-Mail-Adresse ein.', { email: 'Ungültige E-Mail-Adresse.' });
  }
  const [local, rawDomain] = parts;
  const domain = domainToASCII(rawDomain).toLowerCase();
  const labels = domain.split('.');
  if (!local || Buffer.byteLength(local, 'utf8') > 64 || !domain || labels.length < 2 || local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      /[<>(),;:"\[\]\\]/u.test(local) || /[\uD800-\uDFFF]/u.test(local) ||
      labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) {
    throw apiError(422, 'INVALID_EMAIL', 'Bitte gib eine gültige E-Mail-Adresse ein.', { email: 'Ungültige E-Mail-Adresse.' });
  }
  const canonical = `${local.normalize('NFC').toLowerCase().normalize('NFC')}@${domain}`;
  if (Buffer.byteLength(canonical, 'utf8') > 254) throw apiError(422, 'INVALID_EMAIL', 'Bitte gib eine gültige E-Mail-Adresse ein.');
  return { original, canonical };
}
export function requirePassword(input: unknown, field = 'password'): string {
  if (typeof input !== 'string' || Array.from(input).length < 12 || Buffer.byteLength(input, 'utf8') > 1024 ||
      input.includes('\0') || Array.from(input).some(c => {
        const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff;
      }) || getConfig().commonPasswords.has(input.normalize('NFC').toLowerCase())) {
    throw apiError(422, 'INVALID_PASSWORD', 'Bitte wähle ein sicheres Passwort.', {
      [field]: 'Mindestens 12 Zeichen, höchstens 1.024 UTF-8-Bytes; keine bekannten häufigen Passwörter.',
    });
  }
  return input;
}
export function requireString(input: unknown, field: string, max = 1024): string {
  if (typeof input !== 'string' || !input || input.length > max) throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { [field]: 'Ungültiger Wert.' });
  return input;
}
export function requireUuid(input: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
  }
  return input;
}
