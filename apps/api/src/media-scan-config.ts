import { isAbsolute } from 'node:path';

/** Worker entry point: the scheduler supplies this environment directly. Do not
 * import the API config loader (it reads the web application's .env on import). */
export function scanConfig(env: NodeJS.ProcessEnv) {
  const required = (key: string) => {
    const value = env[key];
    if (!value?.trim()) throw new Error(`Missing ${key}`);
    return value;
  };
  const databaseUrl = required('DATABASE_URL');
  const endpoint = new URL(required('MEDIA_S3_ENDPOINT'));
  const region = required('MEDIA_S3_REGION'), bucket = required('MEDIA_QUARANTINE_BUCKET');
  const socket = required('MEDIA_SCAN_CLAMD_SOCKET'), accessKeyId = required('MEDIA_SCAN_ACCESS_KEY_ID');
  if (!['postgresql:', 'postgres:'].includes(new URL(databaseUrl).protocol) || !isAbsolute(socket) ||
      endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-z0-9-]+$/.test(region) ||
      bucket === env.MEDIA_S3_BUCKET || [env.MEDIA_S3_ACCESS_KEY_ID, env.MEDIA_QUARANTINE_ACCESS_KEY_ID].includes(accessKeyId)) {
    throw new Error('Invalid worker database, quarantine reader, endpoint or socket');
  }
  return { databaseUrl, socket, store: { origin: endpoint.origin, bucket, region, accessKeyId,
    secretAccessKey: required('MEDIA_SCAN_SECRET_ACCESS_KEY') } };
}
