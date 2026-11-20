/** Name rules are shared by browser and API. PostgreSQL has the equivalent CHECK. */
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const TRIM_POINTS = new Set([
  ...range(0x09, 0x0d), 0x20, 0x85, 0xa0, 0x1680,
  ...range(0x2000, 0x200a), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0x200b, 0xfeff,
]);
const NON_CONTENT_POINTS = new Set([...TRIM_POINTS, 0x200c, 0x200d, 0x2060]);

export type NameResult = { ok: true; value: string } | { ok: false; message: string };

export function normalizePersonName(input: unknown): NameResult {
  if (typeof input !== 'string') return { ok: false, message: 'Bitte gib einen Namen ein.' };
  const chars = Array.from(input);
  if (chars.some(char => {
    const n = char.codePointAt(0)!;
    return n === 0 || (n >= 0xd800 && n <= 0xdfff);
  })) return { ok: false, message: 'Der Name enthält ungültige Zeichen.' };
  while (chars.length && TRIM_POINTS.has(chars[0].codePointAt(0)!)) chars.shift();
  while (chars.length && TRIM_POINTS.has(chars[chars.length - 1].codePointAt(0)!)) chars.pop();
  if (chars.length === 0 || !chars.some(char => !NON_CONTENT_POINTS.has(char.codePointAt(0)!))) {
    return { ok: false, message: 'Bitte gib einen Namen ein.' };
  }
  if (chars.length > 120) return { ok: false, message: 'Der Name darf höchstens 120 Zeichen haben.' };
  if (chars.some(char => {
    const n = char.codePointAt(0)!;
    return (n >= 1 && n <= 31) || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029;
  })) return { ok: false, message: 'Der Name darf keine Steuer- oder Zeilentrennzeichen enthalten.' };
  return { ok: true, value: chars.join('') };
}

export const BACKOFFICE_ROLES = ['superadmin', 'admin', 'course_manager', 'instructor', 'support'] as const;
export const ALL_ROLES = ['participant', ...BACKOFFICE_ROLES] as const;
export type RoleKey = (typeof ALL_ROLES)[number];

/** Every field in this allowlist is intended to be public once an imprint is released. */
export const providerFields = {
  legal_provider_name: ['Rechtliche Anbieterbezeichnung',160,true], responsible_name: ['Verantwortliche Person',120,true],
  legal_form: ['Rechtsform',100,false], street: ['Straße und Hausnummer',160,true], street_extra: ['Adresszusatz',160,false],
  postal_code: ['Postleitzahl',16,true], city: ['Ort',120,true], country: ['Land (zweistelliger Code)',2,true],
  contact_email: ['Kontakt-E-Mail',254,true], phone: ['Telefon',60,false], registration_details: ['Registerangaben',300,false],
  vat_id: ['USt-IdNr.',30,false], additional_legal_info: ['Weitere Anbieterangaben',1000,false],
} as const;
export type ProviderField = keyof typeof providerFields;
export type ProviderDetails = Record<ProviderField,string>;
