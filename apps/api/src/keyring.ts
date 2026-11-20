import { readFileSync } from 'node:fs';

/** A mounted secret containing only additional decryption keys. Never try keys in turn. */
export function previousKeys(
  file: string | undefined,
  activeId: string,
  reserved: Buffer[],
): ReadonlyMap<string, Buffer> {
  const keys = new Map<string, Buffer>();
  if (!file) return keys;
  try {
    const raw = readFileSync(file);
    if (raw.length > 16384) throw Error();
    const entries: unknown = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(entries) || entries.length > 32) throw Error();
    const used = new Set(reserved.map((k) => k.toString('base64')));
    for (const row of entries) {
      if (
        !row ||
        Object.keys(row).sort().join(',') !== 'id,key' ||
        typeof row.id !== 'string' ||
        !row.id.trim() ||
        row.id.length > 128 ||
        row.id === activeId ||
        keys.has(row.id) ||
        typeof row.key !== 'string' ||
        !/^[A-Za-z0-9+/]{43}=$/.test(row.key) ||
        used.has(row.key)
      )
        throw Error();
      const key = Buffer.from(row.key, 'base64');
      if (key.length !== 32 || key.toString('base64') !== row.key) throw Error();
      used.add(row.key);
      keys.set(row.id, key);
    }
  } catch {
    throw new Error('Invalid DATA_DECRYPTION_KEYS_FILE.');
  }
  return keys;
}
