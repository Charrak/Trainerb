export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, string>) {
    super(message);
  }
}

async function read<T>(response: Response): Promise<T> {
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiError(response.status, body?.code || 'REQUEST_FAILED',
    body?.message || 'Die Anfrage konnte nicht verarbeitet werden.', body?.details);
  return body as T;
}

export async function api<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET', body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  try {
    const file = body instanceof File ? body : undefined;
    if (method !== 'GET') {
      const csrf = await read<{ csrf_token: string }>(await fetch('/api/v1/auth/csrf', { cache: 'no-store', credentials: 'same-origin' }));
      headers['X-CSRF-Token'] = csrf.csrf_token;
      headers['Content-Type'] = file ? 'application/octet-stream' : 'application/json';
      if (file) headers['X-Upload-Name'] = encodeURIComponent(file.name);
    }
    return await read<T>(await fetch(`/api/v1${path}`, { method, headers, cache: 'no-store', credentials: 'same-origin',
      ...(body !== undefined ? { body: file ?? JSON.stringify(body) } : {}) }));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, 'NETWORK_ERROR', 'Die Verbindung ist vorübergehend nicht verfügbar. Bitte versuche es erneut.');
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Die Anfrage konnte nicht verarbeitet werden. Bitte versuche es erneut.';
}
export type Profile = { id: string; first_name: string; last_name: string; email: string; locale: string; roles: string[]; permissions: string[] };
export const isBackoffice = (profile: Profile) => profile.roles.some(role => ['superadmin', 'admin', 'course_manager', 'instructor', 'support'].includes(role));
