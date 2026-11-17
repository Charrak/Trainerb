import { Prisma } from '@prisma/client';
import { apiError, bodyObject } from './security';

const invalid = (field: string): never => {
  throw apiError(422, 'INVALID_CONTENT_FIELD', 'Bitte prüfe den Inhaltsbaustein.', { [field]: 'Ungültiger Wert.' });
};

function contentText(value: unknown, field: string, max: number, multiline = false): string {
  if (typeof value !== 'string') return invalid(field);
  const normalized = value.normalize('NFC').trim();
  if (!normalized || !normalized.replace(/[\p{White_Space}\u200b-\u200d\u2060\ufeff]/gu, '') ||
      Array.from(normalized).length > max || /\p{Cs}/u.test(normalized) ||
      Array.from(normalized).some(character => /\p{Cc}/u.test(character) && !(multiline && ['\n', '\r', '\t'].includes(character))) ||
      (!multiline && /[\u2028\u2029]/u.test(normalized))) return invalid(field);
  return normalized;
}

function contentHref(value: unknown): string {
  const href = contentText(value, 'href', 2048);
  if (/[\p{White_Space}\p{Cc}\p{Cf}\\]/u.test(href)) return invalid('href');
  try {
    if (href.startsWith('/') && !href.startsWith('//')) {
      const internalBase = 'https://trainerb.invalid';
      const url = new URL(href, internalBase);
      if (url.origin !== internalBase || url.username || url.password) return invalid('href');
      return `${url.pathname}${url.search}${url.hash}`;
    }
    const url = new URL(href);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return invalid('href');
    return url.href;
  } catch { return invalid('href'); }
}

/** Each relational row contains exactly one typed block and a stable server-generated ID. */
export function contentDocument(input: unknown, id: string): Prisma.InputJsonObject {
  const block = bodyObject(input, ['kind', 'text', 'level', 'items', 'href']);
  switch (block.kind) {
    case 'paragraph':
      bodyObject(input, ['kind', 'text']);
      return { schema_version: 1, blocks: [{ id, kind: 'paragraph', text: contentText(block.text, 'text', 7000, true) }] };
    case 'heading':
      bodyObject(input, ['kind', 'text', 'level']);
      if (typeof block.level !== 'number' || !Number.isInteger(block.level) || block.level < 2 || block.level > 4) return invalid('level');
      return { schema_version: 1, blocks: [{ id, kind: 'heading', level: block.level, text: contentText(block.text, 'text', 240) }] };
    case 'list':
      bodyObject(input, ['kind', 'items']);
      if (!Array.isArray(block.items) || block.items.length < 1 || block.items.length > 30) return invalid('items');
      return { schema_version: 1, blocks: [{ id, kind: 'list', items: block.items.map(item => contentText(item, 'items', 200)) }] };
    case 'link':
      bodyObject(input, ['kind', 'text', 'href']);
      return { schema_version: 1, blocks: [{ id, kind: 'link', text: contentText(block.text, 'text', 240), href: contentHref(block.href) }] };
    default: return invalid('kind');
  }
}

/** Old clients must not overwrite or delete a document with an unknown schema. */
export function supportedContentDocument(value: Prisma.JsonValue, id: string): boolean {
  try {
    const doc = bodyObject(value, ['schema_version', 'blocks']);
    if (doc.schema_version !== 1 || !Array.isArray(doc.blocks) || doc.blocks.length !== 1) return false;
    const block = bodyObject(doc.blocks[0], ['id', 'kind', 'text', 'level', 'items', 'href']);
    if (block.id !== id) return false;
    const { id: _id, ...editorInput } = block;
    contentDocument(editorInput, id);
    return true;
  } catch { return false; }
}
