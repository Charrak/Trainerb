export type CourseListItem = {
  id: string; slug: string; status: string; visibility: string; updated_at: string;
  draft: { id: string; version: number; title: string } | null;
  needs_draft?: boolean;
};
export type Page<T> = { data: T[]; next_cursor: string | null };
export type CourseMutate = (path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown, success: string, chapterId?: string) =>
  Promise<{ ok: true; value: unknown } | { ok: false }>;
export type Chapter = { id: string; title: string; summary: string | null; position: number; estimated_minutes: number | null; revision: number;
  _count: { contents: number } };
export type Module = { id: string; title: string; description: string | null; position: number; revision: number; chapters: Chapter[] };
export type Version = { id: string; version: number; state: string; title: string; subtitle: string | null; description: unknown;
  chapter_completion_mode: string; expected_module_count: number | null; expected_chapter_count: number | null;
  expected_exams_per_chapter: number | null; revision: number; modules: Module[] };
export type CourseDetail = { id: string; slug: string; status: string; visibility: string; versions: Version[];
  staff?: { user_id: string; scope_role: string }[] };
export const visibilityLabels: Record<string, string> = { private: 'Privat', public: 'Öffentlich', unlisted: 'Nicht gelistet' };
export const modeLabels: Record<string, string> = { self_confirm: 'Selbst bestätigen', all_chapter_exams: 'Alle Kapitelprüfungen bestehen',
  self_or_all_chapter_exams: 'Selbst bestätigen oder alle Kapitelprüfungen bestehen' };

export function descriptionText(value: unknown): string {
  if (!value || typeof value !== 'object' || !('schema_version' in value) || value.schema_version !== 1 || !('blocks' in value) || !Array.isArray(value.blocks)) return '';
  return value.blocks.filter((block: unknown): block is { kind: string; text: string } => !!block && typeof block === 'object' &&
    'kind' in block && block.kind === 'paragraph' && 'text' in block && typeof block.text === 'string').map(block => block.text).join('\n\n');
}
export function editableDescription(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'schema_version' in value && value.schema_version === 1 &&
    'blocks' in value && Array.isArray(value.blocks) && value.blocks.every((block: unknown) => !!block && typeof block === 'object' &&
      'kind' in block && block.kind === 'paragraph' && 'text' in block && typeof block.text === 'string');
}
export function nextPosition(items: { position: number }[]): number {
  const occupied = new Set(items.map(item => item.position));
  let position = 1;
  while (occupied.has(position)) position++;
  return position;
}
export function optionalNumber(form: FormData, key: string): number | null {
  const value = String(form.get(key) ?? '').trim();
  return value ? Number(value) : null;
}
export function textValue(form: FormData, key: string): string { return String(form.get(key) ?? ''); }
